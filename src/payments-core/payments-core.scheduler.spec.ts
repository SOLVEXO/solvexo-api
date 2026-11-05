/* eslint-disable prettier/prettier */
// The jobs run here through the REAL @nestjs/schedule scheduler (not by calling their methods): short intervals are set BEFORE the service
// modules are loaded, because the interval / cron expressions are read when the decorators are evaluated.
process.env.PAYMENTS_TICK_MS = '250';
process.env.KYB_RETENTION_CRON = '* * * * * *';
process.env.KYB_RETENTION_JOB_ENABLED = 'true';
process.env.PAYMENTS_POLLER_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makePaymentsFixture, secondInstance, setKybKeys } = require('./testing/payments-harness') as typeof import('./testing/payments-harness');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PaymentsPollerService } = require('./payments-poller.service') as typeof import('./payments-poller.service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { KybMaintenanceService } = require('../kyb/kyb-maintenance.service') as typeof import('../kyb/kyb-maintenance.service');

jest.setTimeout(120_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => Promise<boolean>, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await sleep(150); } return false; };

const boot = async (poller: any, maintenance: any): Promise<INestApplication> => {
  const mod = await Test.createTestingModule({ imports: [ScheduleModule.forRoot()], providers: [{ provide: PaymentsPollerService, useValue: poller }, { provide: KybMaintenanceService, useValue: maintenance }] }).compile();
  const app = mod.createNestApplication(); await app.init(); return app;
};

describe('jobs run by the real scheduler, two instances at once', () => {
  it('QR expiry, polling (no-webhook provider), webhook retry queue and KYB retention each run on their own, once, with no duplicate events', async () => {
    setKybKeys({ v1: true, current: '1' });
    const x = await makePaymentsFixture({ supportsWebhooks: false }); const b = secondInstance(x);
    let appA: INestApplication | undefined; let appB: INestApplication | undefined;
    try {
      // fixtures for every job
      const toExpire = await x.create();                                              // QR expiry
      await x.intents.collection.updateOne({ _id: new Types.ObjectId(toExpire.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const toConfirm = await x.create({ mockScenario: 'auto_confirm' });             // polling
      const retry = await x.create();                                                 // webhook retry queue
      const spy = jest.spyOn(x.core, 'applyOutcome').mockRejectedValueOnce(new Error('db blip'));
      await x.send('confirmed', retry.id); spy.mockRestore();
      await x.outcomes.collection.updateMany({ result: 'error' }, { $set: { at: new Date(Date.now() - 3600_000) } }); // its backoff is over
      await x.maintenance.updateSettings('adm', { afterClosureDays: 30, purgeEnabled: true });  // KYB retention
      const sid = String(new Types.ObjectId());
      await x.h.repos.storeModel.collection.insertOne({ _id: new Types.ObjectId(sid), sellerId: 's', name: 'Closed', slug: 'closed-' + sid, isDelete: true, updatedAt: new Date(Date.now() - 90 * 86400_000) });
      await x.kybModel.collection.insertOne({ storeId: sid, sellerId: 's', status: 'verified', documents: [{ type: 'owner_cnic', publicId: `private/kyb/${sid}/a`, resourceType: 'raw', fileName: 'a.pdf' }], history: [], cnicEnc: 'kyb:v1:x:y:z', purgedAt: null });

      expect(await x.eventTypes(toExpire.id)).toEqual(['created']); expect(await x.eventTypes(retry.id)).toEqual(['created']);
      appA = await boot(x.poller, x.maintenance); appB = await boot(b.poller, b.maintenance);   // two "servers" with a live scheduler each

      expect(await until(async () => (await x.eventTypes(toExpire.id)).join() === 'created,expired')).toBe(true);
      expect(await until(async () => (await x.eventTypes(toConfirm.id)).includes('confirmed'))).toBe(true);
      expect(await until(async () => (await x.eventTypes(retry.id)).includes('confirmed'))).toBe(true);
      expect(await until(async () => !!((await x.kybModel.collection.findOne({ storeId: sid })) as any)?.purgedAt)).toBe(true);
      // every job has now produced its result; wait for the retry job's final outcome too (how soon it runs depends on machine load), then let
      // both schedulers keep ticking for a while: nothing may be written twice
      expect(await until(async () => ((await x.outcomes.find().lean()) as any[]).some((o) => ['processed', 'ignored', 'dead'].includes(o.result)))).toBe(true);
      await sleep(2500);

      expect(await x.eventTypes(toExpire.id)).toEqual(['created', 'expired']);
      expect((await x.eventTypes(toConfirm.id)).filter((t: string) => t === 'confirmed')).toHaveLength(1);
      expect(await x.eventTypes(retry.id)).toEqual(['created', 'confirmed']);
      // the retry queue finished the notification exactly once (the poller may have confirmed the payment first, which makes it 'ignored')
      expect(await until(async () => ((await x.outcomes.find().lean()) as any[]).some((o) => ['processed', 'ignored', 'dead'].includes(o.result)))).toBe(true);
      expect(((await x.outcomes.find().lean()) as any[]).filter((o) => ['processed', 'ignored', 'dead'].includes(o.result))).toHaveLength(1);
      expect(await x.kybAuditModel.countDocuments({ action: 'kyb_purged', storeId: sid })).toBe(1);
      expect(x.upload.deletePrivateFile.mock.calls.filter((c: any[]) => String(c[0]).includes(sid))).toHaveLength(1);
      const dupes: any[] = await x.events.aggregate([{ $group: { _id: { i: '$intentId', t: '$type' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
      expect(dupes.filter((d) => ['created', 'expired', 'confirmed', 'failed'].includes(d._id.t))).toEqual([]);
    } finally {
      await appA?.close(); await appB?.close();
      await sleep(800); // a tick that was already running when the schedulers stopped must finish before the database is dropped under it
      await x.stop(); setKybKeys({ v1: false, current: null });
    }
  });
});
