/**
 * End-to-end check of guest draft-order invoices against a REAL MongoDB (real schemas, indexes, Mongoose hooks).
 * Redis, Stripe, e-mail, finance and exchange rates are in-memory stand-ins; nothing talks to the internet.
 *
 *   MONGO_URI=mongodb://127.0.0.1:27099/solvexo_draft_e2e  (run from a folder WITHOUT the repo .env)
 *   NODE_OPTIONS=--max-old-space-size=6144 npx ts-node -r tsconfig-paths/register scripts/e2e-draft-guest-mongo.ts
 *
 * Safety: refuses any MONGO_URI that is not on localhost, and drops its own database when it is done.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Connection, Types } from 'mongoose';
import { DatabaseModule } from '../src/database/database.module';
import { DatabaseService } from '../src/database/databaseservice';
import { ActivityLogService } from '../src/activity-log/activity-log.service';
import { ExchangeRateService } from '../src/exchange-rate/exchange-rate.service';
import { EmailService } from '../src/otp/services/email.service';
import { StripeConnectService } from '../src/stripe-connect/stripe-connect.service';
import { CommissionRulesService } from '../src/commission-rules/commission-rules.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { FinanceService } from '../src/finance/finance.service';
import { DraftOrdersService } from '../src/draft-orders/draft-orders.service';

const uri = process.env.MONGO_URI ?? '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
  console.error('Refusing to run: MONGO_URI must point at a local MongoDB.');
  process.exit(2);
}

let failed = 0;
const ok = (cond: unknown, msg: string) => { if (!cond) { failed++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const rejects = async (p: Promise<unknown>, msg: string, part = '') => {
  try { await p; ok(false, msg); } catch (e: any) { ok(!part || String(e?.message).toLowerCase().includes(part.toLowerCase()), `${msg} (${e?.message})`); }
};

async function main() {
  const sentMails: any[] = [];
  const sales: any[] = [];
  const mod = await Test.createTestingModule({
    imports: [DatabaseModule],
    providers: [
      DraftOrdersService,
      { provide: ActivityLogService, useValue: { log: async () => undefined } },
      { provide: ExchangeRateService, useValue: { buildSnapshots: async () => [] } },
      { provide: EmailService, useValue: { sendMail: async () => true } },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: StripeConnectService, useValue: {} },
      { provide: CommissionRulesService, useValue: {} },
      { provide: NotificationsService, useValue: { sendCustomerEmail: async (a: any) => { sentMails.push(a); return 'sent'; }, notify: async () => undefined } },
      { provide: FinanceService, useValue: { recordSale: async (...a: any[]) => { sales.push(a); } } },
    ],
  }).compile();

  const db = mod.get(DatabaseService);
  const conn = mod.get<Connection>(getConnectionToken());
  const r: any = db.repositories;
  const svc = mod.get(DraftOrdersService);
  await Promise.all(Object.values(conn.models).map((m: any) => m.init().catch(() => undefined)));

  const storeId = new Types.ObjectId();
  const S = String(storeId);
  const SELLER = new Types.ObjectId();
  const SEL = String(SELLER);
  await r.storeModel.collection.insertOne({ _id: storeId, name: 'Amara Wears', slug: 'amara', sellerId: SELLER, isDelete: false, status: 'active', baseCurrency: 'PKR', country: 'PK', defaultLanguage: 'en' });

  const item = (n: string, price: number) => ({ productId: String(new Types.ObjectId()), variantId: String(new Types.ObjectId()), type: 'digital', name: n, image: null, sku: null, options: [], quantity: 1, unitPrice: price });
  const mkDraft = async (over: Record<string, unknown> = {}) => (await r.draftOrderModel.create({
    storeId: S, sellerId: SEL, customerId: null, customerName: 'Uzair', customerEmail: 'Uzair@Example.com', customerPhone: '0331',
    items: [item('Ebook', 500)], subtotal: 500, discountAmount: 0, shippingAmount: 0, taxAmount: 0, total: 500, currency: 'PKR', status: 'open', ...over,
  })).toObject();
  const users = () => r.userModel.countDocuments({ storeId: S });

  // ---- 1. a guest draft is invoiced: mail + secure token, but NO customer account yet ----
  const d1 = await mkDraft();
  const res: any = await svc.sendInvoice(S, SEL, String(d1._id));
  ok(res.success && /pay-invoice\/[0-9a-f]{48}$/.test(res.data.invoiceUrl), 'guest invoice returns a secure pay link');
  ok(sentMails.length === 1 && sentMails[0].to === 'Uzair@Example.com' && sentMails[0].event === 'draft_order_invoice', 'invoice e-mail went to the typed address');
  ok(Array.isArray(sentMails[0].attachments) && sentMails[0].attachments[0]?.contentType === 'application/pdf', 'the invoice PDF is attached');
  ok((await users()) === 0, 'sending the invoice creates no customer account');
  const saved: any = await r.draftOrderModel.findById(d1._id).lean();
  ok(!!saved.invoiceToken && !!saved.invoiceSentAt && !saved.customerId, 'token saved on the draft, still a guest');

  // ---- 2. no / bad email is refused ----
  await rejects(svc.sendInvoice(S, SEL, String((await mkDraft({ customerEmail: '' }))._id)), 'invoice without an email is refused', 'email');
  await rejects(svc.sendInvoice(S, SEL, String((await mkDraft({ customerEmail: 'nope' }))._id)), 'invoice to a malformed email is refused', 'valid email');

  // ---- 3. the customer pays (Stripe webhook payload) -> account created, draft becomes a real order ----
  await svc.finalizeInvoicePayment({ id: 'pi_e2e_1', metadata: { draftOrderId: String(d1._id), purpose: 'draft_order_invoice', settledViaConnect: 'true', connectedAccountId: 'acct_e2e' } });
  const u: any[] = await r.userModel.find({ storeId: S }).lean();
  ok(u.length === 1 && u[0].email === 'uzair@example.com' && u[0].role === 'user' && !u[0].password, 'paying created ONE store-scoped customer (lower-cased email, no password)');
  ok((await r.storeCustomerMetaModel.countDocuments({ storeId: S, userId: String(u[0]._id) })) === 1, 'the customer shows in the store customer list');
  const done: any = await r.draftOrderModel.findById(d1._id).lean();
  ok(done.status === 'completed' && done.isPaid && String(done.customerId) === String(u[0]._id) && !!done.orderId, 'draft is completed, paid and linked to the new customer');
  const order: any = await r.orderModel.findById(done.orderId).lean();
  ok(String(order.userId) === String(u[0]._id) && order.isPaid && order.paymentStatus === 'paid' && order.totalAmount === 500, 'the real Order belongs to the new customer and is paid');
  ok(sales.length === 1, 'the sale reached the finance ledger once');

  // ---- 4. the same payment arriving twice (webhook retry) changes nothing ----
  await svc.finalizeInvoicePayment({ id: 'pi_e2e_1', metadata: { draftOrderId: String(d1._id), purpose: 'draft_order_invoice' } });
  ok((await users()) === 1 && (await r.orderModel.countDocuments({ checkoutId: `draft-${d1._id}` })) === 1 && sales.length === 1, 'webhook retry: still one customer, one order, one sale');

  // ---- 5. seller completes another guest draft herself: same email reuses the account ----
  const d2 = await mkDraft({ customerName: 'Uzair H', customerEmail: 'uzair@example.com' });
  const c2: any = await svc.complete(S, SEL, String(d2._id));
  const o2: any = await r.orderModel.findById(c2.orderId).lean();
  ok((await users()) === 1 && String(o2.userId) === String(u[0]._id), 'completing a guest draft with a known email reuses that customer (no duplicate)');
  ok(o2.paymentStatus === 'pending_verification' && !o2.isPaid, 'an unpaid manual completion stays unpaid');

  // ---- 6. a brand-new email creates a brand-new customer on completion ----
  const d3 = await mkDraft({ customerName: 'Sara', customerEmail: 'sara@example.com' });
  const c3: any = await svc.complete(S, SEL, String(d3._id));
  const o3: any = await r.orderModel.findById(c3.orderId).lean();
  const sara: any = await r.userModel.findOne({ storeId: S, email: 'sara@example.com' }).lean();
  ok((await users()) === 2 && sara && String(o3.userId) === String(sara._id), 'completing a guest draft with a new email creates that customer and orders under them');

  // ---- 7. guest without an email cannot be completed, and nobody is created ----
  const before = await users();
  await rejects(svc.complete(S, SEL, String((await mkDraft({ customerEmail: '' }))._id)), 'completing a guest with no email is refused', 'email');
  ok((await users()) === before, 'a refused completion creates no customer');

  // ---- 8. another store with the same email gets its own separate customer ----
  const other = new Types.ObjectId();
  await r.storeModel.collection.insertOne({ _id: other, name: 'Other', slug: 'other', sellerId: SELLER, isDelete: false, status: 'active', baseCurrency: 'PKR', country: 'PK' });
  const d4 = (await r.draftOrderModel.create({
    storeId: String(other), sellerId: SEL, customerId: null, customerName: 'Uzair', customerEmail: 'uzair@example.com', customerPhone: '',
    items: [item('Ebook', 100)], subtotal: 100, discountAmount: 0, shippingAmount: 0, taxAmount: 0, total: 100, currency: 'PKR', status: 'open',
  })).toObject();
  await svc.complete(String(other), SEL, String(d4._id));
  const separate: any[] = await r.userModel.find({ email: 'uzair@example.com' }).lean();
  ok(separate.length === 2 && new Set(separate.map((x) => x.storeId)).size === 2, 'the same email in a different store is a separate customer (tenant isolation)');

  console.log(failed ? `\n${failed} FAILED` : '\nALL OK');
  await conn.dropDatabase();
  await mod.close();
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => { console.error(e); process.exit(1); });
