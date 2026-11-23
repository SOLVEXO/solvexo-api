/* eslint-disable prettier/prettier */
import { requestActor } from './activity-actor.context';
import { ActivityLogService } from './activity-log.service';

describe('ActivityLogService — bulk import suppresses per-row entries', () => {
  function make() {
    const created: any[] = [];
    const activityLogModel = { create: jest.fn(async (d: any) => { created.push(d); return { toObject: () => d }; }) };
    const db: any = { repositories: { activityLogModel } };
    const gateway: any = { emitNewActivity: jest.fn() };
    return { svc: new ActivityLogService(db, gateway), created };
  }
  const ctx = { userId: 'u', role: 'seller', sellerId: null };

  it('drops row entries inside a bulk import but keeps a forced summary entry', async () => {
    const { svc, created } = make();
    await requestActor.run({ ...ctx, bulkImport: true }, async () => {
      await svc.log({ storeId: 's', category: 'marketing', action: 'collection_created' });
      await svc.log({ storeId: 's', category: 'marketing', action: 'collection_imported', force: true });
    });
    expect(created.map((c) => c.action)).toEqual(['collection_imported']);
  });

  it('logs normally outside an import', async () => {
    const { svc, created } = make();
    await requestActor.run(ctx, async () => { await svc.log({ storeId: 's', category: 'marketing', action: 'collection_created' }); });
    await svc.log({ storeId: 's', category: 'marketing', action: 'cron_event' });
    expect(created).toHaveLength(2);
  });
});
