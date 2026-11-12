/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { MongoHarness, seedStore, startMongoHarness } from '../../pos/testing/mongo-harness';
import {
  PaymentEvent, PaymentEventSchema, PaymentIntent, PaymentIntentSchema, PaymentWebhookInbox, PaymentWebhookInboxSchema,
  PaymentWebhookOutcome, PaymentWebhookOutcomeSchema,
} from '../schemas/payments.schemas';
import { KybAuditEvent, KybAuditEventSchema, KybSettings, KybSettingsSchema, StoreKyb, StoreKybSchema } from '../../kyb/kyb.schemas';
import { JobLease, JobLeaseSchema } from '../../common/job-lease/job-lease.schema';
import { JobLeaseService } from '../../common/job-lease/job-lease.service';
import { MockPaymentProvider } from '../providers/mock.provider';
import { PaymentsCoreService } from '../payments-core.service';
import { PaymentsWebhookService } from '../payments-webhook.service';
import { PaymentsPollerService } from '../payments-poller.service';
import { KybGateService } from '../../kyb/kyb-gate.service';
import { KybAuditService } from '../../kyb/kyb-audit.service';
import { KybService } from '../../kyb/kyb.service';
import { KybAdminService } from '../../kyb/kyb-admin.service';
import { KybMaintenanceService } from '../../kyb/kyb-maintenance.service';

export const TEST_KEY_V1 = Buffer.alloc(32, 1).toString('base64');
export const TEST_KEY_V2 = Buffer.alloc(32, 2).toString('base64');

export function setKybKeys(opts: { v1?: boolean; v2?: boolean; current?: string | null } = { v1: true, current: '1' }) {
  delete process.env.KYB_ENC_KEY_V1; delete process.env.KYB_ENC_KEY_V2; delete process.env.KYB_ENC_KEY_CURRENT;
  if (opts.v1) process.env.KYB_ENC_KEY_V1 = TEST_KEY_V1;
  if (opts.v2) process.env.KYB_ENC_KEY_V2 = TEST_KEY_V2;
  if (opts.current) process.env.KYB_ENC_KEY_CURRENT = opts.current;
}

export function fakeUpload() {
  const files = new Map<string, Buffer>();
  return {
    files,
    uploadPrivateFile: jest.fn(async (file: any, folder: string) => { const publicId = `${folder}/${Math.random().toString(36).slice(2)}`; files.set(publicId, file.buffer ?? Buffer.from('x')); return { publicId, resourceType: 'raw', fileName: file.originalname, fileSize: file.size ?? 1, mimeType: file.mimetype }; }),
    deletePrivateFile: jest.fn(async (publicId: string) => { files.delete(publicId); return 'ok'; }),
    deleteFile: jest.fn(async (publicId: string) => { files.delete(publicId); }),
    generateExpiringPrivateUrl: jest.fn((publicId: string, _t: string, secs: number) => `https://signed.example/${publicId}?exp=${secs}`),
    generateSignedUrl: jest.fn((publicId: string, _t: string, secs: number) => `https://signed.example/${publicId}?exp=${secs}`),
    downloadPrivateFileBuffer: jest.fn(async (publicId: string) => files.get(publicId) ?? Buffer.from('missing')),
  } as any;
}

type Opts = { supportsWebhooks?: boolean; qrValiditySeconds?: number; verified?: boolean; upload?: any };

/** The expensive part, done ONCE per spec file: one throw-away database with every model and index built. */
export async function makeBase() {
  const h: MongoHarness = await startMongoHarness();
  const m = (cls: any, sch: any) => { const model = h.conn.model(cls.name, sch); h.repos[`_${cls.name}`] = model; return model; };
  const leaseModel = m(JobLease, JobLeaseSchema);
  const intents = m(PaymentIntent, PaymentIntentSchema); const events = m(PaymentEvent, PaymentEventSchema);
  const inbox = m(PaymentWebhookInbox, PaymentWebhookInboxSchema); const outcomes = m(PaymentWebhookOutcome, PaymentWebhookOutcomeSchema);
  const kybModel = m(StoreKyb, StoreKybSchema); const kybAuditModel = m(KybAuditEvent, KybAuditEventSchema); const kybSettings = m(KybSettings, KybSettingsSchema);
  await Promise.all([leaseModel, intents, events, inbox, outcomes, kybModel, kybAuditModel, kybSettings].map((x: any) => x.init()));
  return { h, leaseModel, intents, events, inbox, outcomes, kybModel, kybAuditModel, kybSettings };
}
export type Base = Awaited<ReturnType<typeof makeBase>>;

/** Cheap: new provider + services (no database work) and a NEW store / register session / KYB, so tests sharing one database never see each other's data. */
export async function buildFixture(base: Base, opts: Opts = {}, ownsBase = false) {
  const { h, leaseModel, intents, events, inbox, outcomes, kybModel, kybAuditModel, kybSettings } = base;
  const mock = new MockPaymentProvider({ webhookSecret: 'unit-test-secret', supportsWebhooks: opts.supportsWebhooks ?? true, qrValiditySeconds: opts.qrValiditySeconds });
  const gate = new KybGateService(kybModel as any);
  const leases = new JobLeaseService(leaseModel as any);
  const core = new PaymentsCoreService(intents as any, events as any, h.repos.storeModel, h.repos.registerSessionModel, h.repos.saleModel, h.repos.posAuditLogModel, [mock], gate, leases);
  const webhooks = new PaymentsWebhookService(core, inbox as any, outcomes as any);
  const poller = new PaymentsPollerService(core, webhooks);
  const upload = opts.upload ?? fakeUpload();
  const kybAudit = new KybAuditService(kybAuditModel as any);
  const kyb = new KybService(kybModel as any, h.repos.storeModel, kybAudit, upload);
  const kybAdmin = new KybAdminService(kybModel as any, h.repos.storeModel, kyb, kybAudit, upload);
  const maintenance = new KybMaintenanceService(kybModel as any, kybSettings as any, h.repos.storeModel, kybAudit, upload, leases);

  const s = await seedStore(h, { baseCurrency: 'PKR' });
  const sessionId = String(new Types.ObjectId());
  await h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sessionId), storeId: s.storeId, registerId: s.registerId, employeeId: s.managerId, status: 'open', openedAt: new Date() });
  if (opts.verified !== false) await verifyStore(h, kybModel, s.storeId, s.sellerId);

  const actor = { storeId: s.storeId, deviceId: 'dev-1', employeeId: s.cashierId };
  const manager = { employeeId: s.managerId };
  let n = 0;
  const create = (extra: any = {}, amountMinor = 150000) => core.createIntent(actor, { amountMinor, sessionId, idempotencyKey: `k-${++n}`, saleAttemptKey: `attempt-${n}`, ...extra });
  const providerRefOf = async (id: string) => ((await intents.findById(id).lean()) as any).providerRef as string;
  const send = async (kind: any, id: string, extra: any = {}) => {
    const providerRef = await providerRefOf(id); const intent: any = await intents.findById(id).lean();
    // a real provider's own state matches what it notifies: keep the mock in step so a later refund / poll sees the same world
    if (extra.sync !== false && (kind === 'confirmed' || kind === 'failed') && extra.amountMinor === undefined) mock.simulate(providerRef, kind === 'confirmed' ? 'confirm' : 'fail');
    const w = mock.buildWebhook({ kind, providerRef, amountMinor: extra.amountMinor === undefined ? intent.amountMinor : extra.amountMinor, ...extra });
    return webhooks.receive('mock', w.body, w.headers, extra.now);
  };
  return {
    h, mock, leases, leaseModel, core, webhooks, poller, gate, intents, events, inbox, outcomes, kybModel, kybAuditModel, kybSettings, kyb, kybAdmin, maintenance, kybAudit, upload,
    s, sessionId, actor, manager, create, send, providerRefOf,
    /** A fork shares the database: stopping it is a no-op (the spec stops the base once). */
    stop: async () => { if (ownsBase) await h.stop(); },
    eventTypes: async (id: string) => ((await events.find({ intentId: id }).sort({ seq: 1 }).lean()) as any[]).map((e) => e.type + (e.late ? '(late)' : '')),
  };
}

/** One fixture that owns its own database (kept for specs that need exactly one). */
export async function makePaymentsFixture(opts: Opts = {}) { return buildFixture(await makeBase(), opts, true); }

/** The cheap way for a spec with many tests: `const f = fixtureFactory(); beforeAll(f.start); afterAll(f.stop); const x = await f.fresh({...})`. */
export function fixtureFactory() {
  let base: Base | undefined;
  return {
    start: async () => { base = await makeBase(); },
    stop: async () => { await base?.h.stop(); },
    fresh: (opts: Opts = {}) => buildFixture(base!, opts, false),
  };
}

export async function verifyStore(h: MongoHarness, kybModel: any, storeId: string, sellerId: string, ref = 'SM-TEST-1', providerKey = 'mock') {
  await kybModel.collection.updateOne({ storeId }, { $set: { storeId, sellerId, status: 'verified', subMerchant: { ref, providerKey, setAt: new Date(), setBy: 'admin-1' }, documents: [], history: [] } }, { upsert: true });
}

/** A SECOND server instance sharing the same database, provider state and storage: its own lease identity, services and poller. */
export function secondInstance(x: Awaited<ReturnType<typeof buildFixture>>) {
  const leases = new JobLeaseService(x.leaseModel as any);
  const core = new PaymentsCoreService(x.intents as any, x.events as any, x.h.repos.storeModel, x.h.repos.registerSessionModel, x.h.repos.saleModel, x.h.repos.posAuditLogModel, [x.mock], x.gate, leases);
  const webhooks = new PaymentsWebhookService(core, x.inbox as any, x.outcomes as any);
  const poller = new PaymentsPollerService(core, webhooks);
  const maintenance = new KybMaintenanceService(x.kybModel as any, x.kybSettings as any, x.h.repos.storeModel, x.kybAudit, x.upload, leases);
  return { leases, core, webhooks, poller, maintenance };
}
