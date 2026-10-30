/**
 * End-to-end check of the digital commerce services against a REAL MongoDB (all real schemas, indexes and Mongoose hooks).
 * Redis, Cloudinary and e-mail are replaced by in-memory stand-ins; nothing talks to the internet.
 *
 *   MONGO_URI=mongodb://127.0.0.1:27098/solvexo_digital_e2e  (run from a folder WITHOUT the repo .env)
 *   NODE_OPTIONS=--max-old-space-size=6144 npx ts-node -r tsconfig-paths/register scripts/e2e-digital-mongo.ts
 *
 * Safety: refuses any MONGO_URI that is not on localhost, and drops its own database when it is done.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { DatabaseModule } from '../src/database/database.module';
import { DatabaseService } from '../src/database/databaseservice';
import { RedisService } from '../src/redis/redis.service';
import { UploadService } from '../src/upload/upload.service';
import { DigitalAccess, DigitalAccessSchema, DeliveryLog, DeliveryLogSchema } from '../src/digital-access/digital-access.schema';
import { DigitalAccessService } from '../src/digital-access/digital-access.service';
import { DigitalDeliveryService } from '../src/digital-access/digital-delivery.service';
import { DigitalMailerService } from '../src/digital-access/digital-mailer.service';
import { AccessPlan, AccessPlanSchema, MemberSubscription, MemberSubscriptionSchema } from '../src/memberships/membership.schema';
import { RenewalInvoice, RenewalInvoiceSchema } from '../src/memberships/renewal-invoice.schema';
import { MembershipsService } from '../src/memberships/memberships.service';
import { RenewalInvoicesService } from '../src/memberships/renewal-invoices.service';
import { FakeRedis } from '../src/digital-access/testing/fake-db.kit-spec';

const uri = process.env.MONGO_URI ?? '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
  console.error('Refusing to run: MONGO_URI must point at a local MongoDB.');
  process.exit(2);
}

let failed = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { failed++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const rejects = async (p: Promise<unknown>, msg: string) => { try { await p; ok(false, msg); } catch { ok(true, msg); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function main() {
  const mails: string[][] = [];
  const mailer: any = {
    purchaseDelivered: (...a: any[]) => mails.push(['purchase', ...a.map(String)]),
    fileUpdated: () => undefined,
    membership: (...a: any[]) => mails.push([String(a[0]), String(a[1]), String(a[2])]),
  };
  const upload: any = {
    resolveMimeType: () => 'application/pdf',
    generateSignedUrl: (id: string, _t: string, secs: number) => `https://signed.invalid/${id}?exp=${secs}`,
    uploadPrivateFile: async (f: any, folder: string) => ({ publicId: `${folder}/e2e-receipt`, fileName: f.originalname, fileSize: f.size, mimeType: f.mimetype }),
  };
  (global as any).fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

  const mod = await Test.createTestingModule({
    imports: [
      DatabaseModule,
      MongooseModule.forFeature([
        { name: DigitalAccess.name, schema: DigitalAccessSchema }, { name: DeliveryLog.name, schema: DeliveryLogSchema },
        { name: AccessPlan.name, schema: AccessPlanSchema }, { name: MemberSubscription.name, schema: MemberSubscriptionSchema },
        { name: RenewalInvoice.name, schema: RenewalInvoiceSchema },
      ]),
    ],
    providers: [
      DigitalAccessService, DigitalDeliveryService, MembershipsService, RenewalInvoicesService,
      { provide: RedisService, useValue: new FakeRedis() }, { provide: UploadService, useValue: upload }, { provide: DigitalMailerService, useValue: mailer },
    ],
  }).compile();

  const db = mod.get(DatabaseService);
  const conn = mod.get<Connection>(getConnectionToken());
  const r: any = db.repositories;
  const access = mod.get(DigitalAccessService);
  const delivery = mod.get(DigitalDeliveryService);
  const memberships = mod.get(MembershipsService);
  const invoices = mod.get(RenewalInvoicesService);
  access.onModuleInit();
  await Promise.all(Object.values(conn.models).map((m: any) => m.init().catch(() => undefined)));

  // ---- seed: store, buyer, digital product ----
  const storeId = new Types.ObjectId();
  const buyerId = new Types.ObjectId();
  const productId = new Types.ObjectId();
  await r.storeModel.collection.insertOne({ _id: storeId, name: 'E2E Store', slug: 'e2e-store', sellerId: 'seller1', isDelete: false, status: 'active', baseCurrency: 'PKR', country: 'PK' });
  await r.userModel.collection.insertOne({ _id: buyerId, name: 'Ayesha', email: 'ayesha@example.com', storeId: String(storeId), isDelete: false });
  await r.productModel.collection.insertOne({
    _id: productId, storeId: String(storeId), sellerId: 'seller1', name: 'Brand Kit', slug: 'brand-kit', type: 'digital', isDelete: false, status: 'active',
    digital: { downloadLimit: '3', linkExpiryDays: null, files: [{ url: 'private/digital-products/kit.pdf', name: 'kit.pdf', size: 10, mimeType: 'application/pdf', position: 0, archived: false }] },
  });
  const S = String(storeId), C = String(buyerId), P = String(productId);

  // ---- 1. a paid order is saved: the Mongoose hook grants access and mails once, nobody opens the library ----
  const order = await new r.orderModel({
    orderNumber: 'E2E-1', userId: C, isPaid: true, isDelete: false,
    sellerOrders: [{ storeId: S, sellerId: 'seller1', items: [{ productId: P, type: 'digital', status: 'pending', quantity: 1, price: 10, totalPrice: 10 }] }],
  }).save({ validateBeforeSave: false });
  await wait(900);
  const accessCount = await (access as any).accessModel.countDocuments({ storeId: S, customerId: C, status: 'active' });
  ok(accessCount === 1, 'paid order => exactly one active DigitalAccess (event-driven, real Mongo)');
  ok(mails.filter((m) => m[0] === 'purchase').length === 1, 'purchase e-mail sent once');
  await (access as any).onOrderChanged(String(order._id));
  await (access as any).onOrderChanged(String(order._id));
  ok((await (access as any).accessModel.countDocuments({ storeId: S })) === 1 && mails.filter((m) => m[0] === 'purchase').length === 1, 'duplicate paid events: still one record, one mail (unique index + mailedAt claim)');

  // ---- 2. secure download: single-use token, replay blocked, limit 3 ----
  const ctx = { ip: '10.0.0.1', userAgent: 'e2e' };
  const t1 = await delivery.mintToken(S, C, P, 0, ctx);
  const file = await delivery.redeem(t1.token, ctx);
  ok(file.buffer.length === 8, 'download through the single-use token');
  await rejects(delivery.redeem(t1.token, ctx), 'replay of the same token is blocked');
  await rejects(delivery.mintToken(S, String(new Types.ObjectId()), P, 0, ctx), 'another customer gets no token');
  await rejects(delivery.mintToken(String(new Types.ObjectId()), C, P, 0, ctx), 'another store gets no token');
  for (let i = 0; i < 2; i++) await delivery.redeem((await delivery.mintToken(S, C, P, 0, ctx)).token, ctx);
  await rejects(delivery.mintToken(S, C, P, 0, ctx), 'the 4th download is refused (limit 3)');
  const log = await (access as any).logModel.find({ storeId: S }).lean();
  ok(log.some((l: any) => l.outcome === 'ok') && log.some((l: any) => l.outcome === 'denied'), 'delivery log has ok and denied rows');

  // ---- 3. manual membership: invoice -> proof -> approve -> renewal extends (idempotent) ----
  const plan: any = await memberships.createPlan(S, { name: 'Gold', type: 'recurring', amount: 1500, interval: 'month', graceDays: 2 });
  const sub: any = await memberships.join(S, C, String(plan._id));
  ok(sub.awaitingFirstPayment === true, 'joining a paid plan waits for the first payment');
  ok(!(await memberships.hasPlanAccess(S, C, String(plan._id))), 'no plan access before payment');
  await invoices.ensureInvoices();
  await invoices.ensureInvoices();
  const open: any[] = await invoices.listMine(S, C);
  ok(open.length === 1 && open[0].status === 'awaiting', 'one first-payment invoice (a second run creates none)');
  await rejects(invoices.submitProof(S, C, open[0].id, { originalname: 'r.png', mimetype: 'image/png', buffer: Buffer.from('not an image'), size: 12 } as any, {}), 'a fake image is refused');
  await invoices.submitProof(S, C, open[0].id, { originalname: 'r.png', mimetype: 'image/png', buffer: PNG, size: PNG.length } as any, { reference: 'TXN-1' });
  ok(((await invoices.listMine(S, C))[0] as any).status === 'submitted', 'receipt submitted');
  ok(((await invoices.proofUrlForBuyer(S, C, open[0].id)) as any).url.includes('private/renewal-proofs'), 'owner gets a short-lived signed receipt link');
  await rejects(invoices.proofUrlForBuyer(S, String(new Types.ObjectId()), open[0].id), "another customer cannot open the receipt");
  await rejects(invoices.approve(String(new Types.ObjectId()), open[0].id, 'x'), 'another store cannot approve');
  await invoices.approve(S, open[0].id, 'seller1');
  await invoices.approve(S, open[0].id, 'seller1');
  const paid: any = await (memberships as any).subModel.findById(sub._id).lean();
  ok(paid.status === 'active' && paid.periodsPaid === 1, 'approve activates the membership once (second approve is a no-op)');
  ok(await memberships.hasPlanAccess(S, C, String(plan._id)), 'member has plan access after approval');
  const end1 = new Date(paid.currentPeriodEnd).getTime();
  await (memberships as any).subModel.updateOne({ _id: sub._id }, { $set: { currentPeriodEnd: new Date(Date.now() + 3 * DAY) } });
  await invoices.ensureInvoices();
  const next: any[] = (await invoices.listMine(S, C)).filter((i: any) => i.status !== 'paid');
  ok(next.length === 1, 'a renewal invoice appears 7 days before the period ends');
  await invoices.approve(S, next[0].id, 'seller1');
  const renewed: any = await (memberships as any).subModel.findById(sub._id).lean();
  ok(new Date(renewed.currentPeriodEnd).getTime() > Date.now() + 3 * DAY + 20 * DAY && renewed.periodsPaid === 2 && end1 > 0, 'renewal approval extends the period by one cycle');

  // ---- 4. refund: the order item is refunded through a plain updateOne => access is revoked by the hook ----
  await r.orderModel.updateOne({ _id: order._id }, { $set: { 'sellerOrders.0.items.0.status': 'refunded' } });
  await wait(900);
  const rec: any = await (access as any).accessModel.findOne({ storeId: S, customerId: C, resourceRef: P }).lean();
  ok(rec?.status === 'revoked', 'refund => DigitalAccess revoked (Mongoose updateOne hook, ObjectId filter)');
  await rejects(delivery.mintToken(S, C, P, 0, ctx), 'no new download token after the refund');

  console.log(failed ? `\n${failed} FAILED` : '\nALL OK');
  await conn.dropDatabase();
  await mod.close();
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => { console.error(e); process.exit(1); });
