import { MembershipsService } from './memberships.service';
import { RenewalInvoicesService } from './renewal-invoices.service';
import { FakeModel, makeDb } from '../digital-access/testing/fake-db.kit-spec';

const DAY = 86_400_000;
const LIVE = ['trialing', 'active', 'past_due', 'paused'];

class SubModel extends FakeModel {
  async create(d: any) {
    if (this.rows.some((r) => r.customerId === d.customerId && r.planId === d.planId && LIVE.includes(r.status))) throw Object.assign(new Error('E11000'), { code: 11000 });
    return super.create(d);
  }
}
class InvoiceModel extends FakeModel { unique = ['subscriptionId', 'cycleKey']; }

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const file = (over: any = {}): any => ({ originalname: 'receipt.png', mimetype: 'image/png', buffer: PNG, size: PNG.length, ...over });

function setup() {
  const k = makeDb();
  const plans = new FakeModel({ status: 'active', graceDays: 2, trialDays: 0, tier: 1, intervalCount: 1, interval: 'month', pauseAllowed: false, productId: null, autoRenew: false });
  const subs = new SubModel({ appliedItemIds: [], periodsPaid: 0, failedCount: 0, cancelAtPeriodEnd: false, reminderSentFor: null, pendingPlanId: null, audit: [], awaitingFirstPayment: false, provider: 'manual' });
  const invoices = new InvoiceModel({ status: 'awaiting', rejectionCount: 0, submissionCount: 0, audit: [], remindersSent: {}, instructions: [], proof: null });
  plans.rows.push(
    { _id: 'gold', storeId: 's1', name: 'Gold', type: 'recurring', amount: 1500, currency: 'PKR', status: 'active', graceDays: 2, trialDays: 0, tier: 1, intervalCount: 1, interval: 'month', pauseAllowed: false, productId: null, autoRenew: false },
    { _id: 'silver', storeId: 's1', name: 'Silver', type: 'recurring', amount: 900, currency: 'PKR', status: 'active', graceDays: 2, trialDays: 0, tier: 1, intervalCount: 1, interval: 'month', pauseAllowed: false, productId: null, autoRenew: false },
    { _id: 'free', storeId: 's1', name: 'Free', type: 'free', amount: 0, currency: 'PKR', status: 'active', graceDays: 2, trialDays: 0, tier: 1, intervalCount: 1, interval: 'month', pauseAllowed: false, productId: null, autoRenew: false },
  );
  k.storeIntegrationModel.rows.push({ storeId: 's1', type: 'payment', provider: 'bank_transfer', config: { bankName: 'HBL', accountTitle: 'Demo Store', accountNumber: '0123', iban: 'PK00HABB0000', jazzcashNumber: '0300111', instructions: 'Send the exact amount' } });
  k.manualPaymentMethodModel.rows.push({ storeId: 's1', name: 'Cash at shop', instructions: 'Pay at the counter', isActive: true, isDelete: false, sortOrder: 0 });
  k.userModel.rows.push({ _id: 'c1', name: 'Ayesha', email: 'a@example.com' }, { _id: 'c2', name: 'Bilal', email: 'b@example.com' });
  const mailer: any = { membership: jest.fn() };
  const uploaded: any[] = [];
  const upload: any = {
    uploadPrivateFile: async (f: any, folder: string) => { uploaded.push(folder); return { publicId: `${folder}/p${uploaded.length}`, fileName: f.originalname, fileSize: f.size, mimeType: f.mimetype }; },
    generateSignedUrl: (id: string, type: string, secs: number) => `https://signed.example/${id}?t=${type}&exp=${secs}`,
  };
  const memberships = new MembershipsService(k.db, plans as any, subs as any, mailer, undefined, invoices as any);
  const svc = new RenewalInvoicesService(k.db, upload, memberships, invoices as any, subs as any, plans as any, mailer);
  return { ...k, plans, subs, invoices, mailer, upload, uploaded, memberships, svc };
}
type S = ReturnType<typeof setup>;
const mails = (s: S) => s.mailer.membership.mock.calls.map((c: any[]) => c[0]);

async function activeSub(s: S, customer = 'c1', plan = 'gold', endsInDays = 5) {
  const sub: any = await s.memberships.join('s1', customer, plan);
  await s.memberships.markPaid('s1', sub._id, 'seller');
  sub.currentPeriodEnd = new Date(Date.now() + endsInDays * DAY);
  sub.currentPeriodStart = new Date(Date.now() - (30 - endsInDays) * DAY);
  return sub;
}
async function invoiceFor(s: S, sub: any) {
  await s.svc.ensureInvoices();
  return s.invoices.rows.find((i) => i.subscriptionId === String(sub._id)) as any;
}
async function submitted(s: S, customer = 'c1') {
  const sub = await activeSub(s, customer);
  const inv = await invoiceFor(s, sub);
  await s.svc.submitProof('s1', customer, inv._id, file(), { reference: 'TXN123' });
  return { sub, inv };
}

describe('payment instructions', () => {
  it('are snapshotted from the seller\'s bank transfer details and custom manual methods', async () => {
    const s = setup();
    const ins = await s.svc.snapshotInstructions('s1');
    const labels = ins.map((i) => i.label);
    expect(labels.includes('Bank transfer')).toBe(true);
    expect(labels.includes('JazzCash')).toBe(true);
    expect(labels.includes('Cash at shop')).toBe(true);
    expect(ins.find((i) => i.label === 'Bank transfer')!.details).toContain('IBAN: PK00HABB0000');
    expect((await s.svc.snapshotInstructions('s2')).length).toBe(0);
  });
});

describe('invoice creation', () => {
  it('creates one invoice per cycle, 7 days before the period ends, idempotently', async () => {
    const s = setup();
    const sub = await activeSub(s, 'c1', 'gold', 6);
    expect(await s.svc.ensureInvoices()).toBe(1);
    expect(await s.svc.ensureInvoices()).toBe(0);
    const inv = s.invoices.rows[0];
    expect(inv.amount).toBe(1500);
    expect(inv.currency).toBe('PKR');
    expect(inv.status).toBe('awaiting');
    expect(inv.cycleKey).toBe('renew:' + sub.currentPeriodEnd.toISOString().slice(0, 10));
    expect(inv.instructions.length).toBeGreaterThan(0);
  });

  it('nothing earlier than 7 days, nothing for free plans, Stripe memberships or memberships being cancelled', async () => {
    const s = setup();
    await activeSub(s, 'c1', 'gold', 20);
    const stripe = await activeSub(s, 'c2', 'silver', 3);
    stripe.provider = 'stripe';
    const cancelling = await s.memberships.join('s1', 'c3', 'gold');
    (cancelling as any).status = 'active'; (cancelling as any).currentPeriodEnd = new Date(Date.now() + 2 * DAY); (cancelling as any).cancelAtPeriodEnd = true;
    const free: any = await s.memberships.join('s1', 'c4', 'free');
    free.currentPeriodEnd = new Date(Date.now() + 2 * DAY);
    expect(await s.svc.ensureInvoices()).toBe(0);
  });

  it('a new paid membership gets a first-payment invoice due in 3 days', async () => {
    const s = setup();
    const sub: any = await s.memberships.join('s1', 'c1', 'gold');
    expect(sub.awaitingFirstPayment).toBe(true);
    await s.svc.ensureInvoices();
    const inv = s.invoices.rows[0];
    expect(inv.cycleKey).toBe('first');
    expect(Math.round((inv.dueAt.getTime() - Date.now()) / DAY)).toBe(3);
  });

  it('a downgrade waiting for the period end is invoiced at the NEW plan price', async () => {
    const s = setup();
    const sub = await activeSub(s, 'c1', 'gold', 4);
    sub.pendingPlanId = 'silver';
    await s.svc.ensureInvoices();
    expect(s.invoices.rows[0].amount).toBe(900);
  });
});

describe('reminders: 7 days, 3 days, due day', () => {
  it('each slot is sent once and never repeated', async () => {
    const s = setup();
    const sub = await activeSub(s, 'c1', 'gold', 6);
    const inv = await invoiceFor(s, sub);
    expect(await s.svc.sendReminders(new Date())).toBe(1); // d7
    expect(await s.svc.sendReminders(new Date())).toBe(0);
    expect(await s.svc.sendReminders(new Date(inv.dueAt.getTime() - 2 * DAY))).toBe(1); // d3
    expect(await s.svc.sendReminders(new Date(inv.dueAt.getTime() - 2 * DAY))).toBe(0);
    expect(await s.svc.sendReminders(new Date(inv.dueAt.getTime() + 1000))).toBe(1); // d0
    expect(await s.svc.sendReminders(new Date(inv.dueAt.getTime() + 2 * DAY))).toBe(0);
    expect(mails(s).filter((m: string) => m === 'membership_renewal_reminder').length).toBe(3);
  });

  it('a late-created invoice only gets the slot that is current, not all three', async () => {
    const s = setup();
    const sub = await activeSub(s, 'c1', 'gold', 1);
    await invoiceFor(s, sub);
    expect(await s.svc.sendReminders(new Date())).toBe(1);
    expect(await s.svc.sendReminders(new Date())).toBe(0);
  });

  it('no reminder once the proof is submitted or the invoice is paid', async () => {
    const s = setup();
    const { inv } = await submitted(s);
    expect(await s.svc.sendReminders(new Date())).toBe(0);
    await s.svc.approve('s1', inv._id, 'seller');
    expect(await s.svc.sendReminders(new Date())).toBe(0);
  });
});

describe('overdue and void', () => {
  it('awaiting becomes overdue after the due date; invoices of ended memberships are voided', async () => {
    const s = setup();
    const sub = await activeSub(s, 'c1', 'gold', 2);
    const inv = await invoiceFor(s, sub);
    const r1 = await s.svc.sweep(new Date(inv.dueAt.getTime() + 1000));
    expect(r1.overdue).toBe(1);
    expect(inv.status).toBe('overdue');
    sub.status = 'cancelled';
    expect((await s.svc.sweep()).voided).toBe(1);
    expect(inv.status).toBe('void');
  });
});

describe('buyer proof upload', () => {
  it('lists only the buyer\'s own invoices and never exposes the proof file', async () => {
    const s = setup();
    const { inv } = await submitted(s);
    const mine: any[] = await s.svc.listMine('s1', 'c1');
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe('submitted');
    expect(JSON.stringify(mine[0]).includes('publicId')).toBe(false);
    expect((await s.svc.listMine('s1', 'c2')).length).toBe(0);
    expect((await s.svc.listMine('s2', 'c1')).length).toBe(0);
    expect(inv.proof.publicId).toContain('private/renewal-proofs/s1');
  });

  it('validates type, size, real file bytes and requires a receipt or a reference', async () => {
    const s = setup();
    const inv = await invoiceFor(s, await activeSub(s));
    await expect(s.svc.submitProof('s1', 'c1', inv._id, undefined, {})).rejects.toThrow('receipt image or a transaction reference');
    await expect(s.svc.submitProof('s1', 'c1', inv._id, file({ mimetype: 'image/gif', originalname: 'a.gif' }), {})).rejects.toThrow('JPG, PNG, WebP or PDF');
    await expect(s.svc.submitProof('s1', 'c1', inv._id, file({ size: 11 * 1024 * 1024 }), {})).rejects.toThrow('10 MB');
    await expect(s.svc.submitProof('s1', 'c1', inv._id, file({ buffer: Buffer.from('this is not a png at all, just text') }), {})).rejects.toThrow('does not match');
    await expect(s.svc.submitProof('s1', 'c1', inv._id, file({ originalname: 'x.exe' }), {})).rejects.toThrow();
    expect(inv.status).toBe('awaiting');
    expect(s.uploaded.length).toBe(0);
  });

  it('a reference alone is enough; a second submit while under review is refused', async () => {
    const s = setup();
    const inv = await invoiceFor(s, await activeSub(s));
    await s.svc.submitProof('s1', 'c1', inv._id, undefined, { reference: 'TXN9', senderName: 'Ayesha' });
    expect(inv.status).toBe('submitted');
    expect(inv.reference).toBe('TXN9');
    await expect(s.svc.submitProof('s1', 'c1', inv._id, file(), {})).rejects.toThrow('already being reviewed');
  });

  it('another customer or another store cannot submit for this invoice', async () => {
    const s = setup();
    const inv = await invoiceFor(s, await activeSub(s));
    await expect(s.svc.submitProof('s1', 'c2', inv._id, file(), { reference: 'x' })).rejects.toThrow('Invoice not found');
    await expect(s.svc.submitProof('s2', 'c1', inv._id, file(), { reference: 'x' })).rejects.toThrow('Invoice not found');
  });

  it('stops after 5 attempts', async () => {
    const s = setup();
    const inv = await invoiceFor(s, await activeSub(s));
    inv.submissionCount = 5;
    await expect(s.svc.submitProof('s1', 'c1', inv._id, file(), { reference: 'x' })).rejects.toThrow('Too many attempts');
  });
});

describe('proof access control', () => {
  it('only the owner buyer and the store can open the receipt, through a 5 minute signed link', async () => {
    const s = setup();
    const { inv } = await submitted(s);
    const own: any = await s.svc.proofUrlForBuyer('s1', 'c1', inv._id);
    expect(own.expiresInSeconds).toBe(300);
    expect(own.url).toContain('private/renewal-proofs/s1');
    expect(own.url).toContain('exp=300');
    await expect(s.svc.proofUrlForBuyer('s1', 'c2', inv._id)).rejects.toThrow('Invoice not found');
    await expect(s.svc.proofUrlForBuyer('s2', 'c1', inv._id)).rejects.toThrow('Invoice not found');
    expect(((await s.svc.proofUrlForSeller('s1', inv._id)) as any).url).toContain('signed.example');
    await expect(s.svc.proofUrlForSeller('s2', inv._id)).rejects.toThrow('Invoice not found');
  });

  it('no receipt, no link', async () => {
    const s = setup();
    const inv = await invoiceFor(s, await activeSub(s));
    await s.svc.submitProof('s1', 'c1', inv._id, undefined, { reference: 'only-ref' });
    await expect(s.svc.proofUrlForBuyer('s1', 'c1', inv._id)).rejects.toThrow('No receipt');
  });
});

describe('approve / reject state machine', () => {
  it('approve extends the period once, even when called twice (idempotent), and mails the buyer', async () => {
    const s = setup();
    const { sub, inv } = await submitted(s);
    const end0 = sub.currentPeriodEnd.getTime();
    await s.svc.approve('s1', inv._id, 'seller');
    const end1 = sub.currentPeriodEnd.getTime();
    await s.svc.approve('s1', inv._id, 'seller');
    expect(inv.status).toBe('paid');
    expect(end1 > end0).toBe(true);
    expect(sub.currentPeriodEnd.getTime()).toBe(end1);
    expect(sub.periodsPaid).toBe(2);
    expect(mails(s).includes('membership_renewal_approved')).toBe(true);
    expect(JSON.stringify(inv.audit)).toContain('approved');
  });

  it('a crash between "invoice paid" and "period extended" is repaired by the next approve', async () => {
    const s = setup();
    const { sub, inv } = await submitted(s);
    inv.status = 'paid'; // first step done, process died before extending
    const end0 = sub.currentPeriodEnd.getTime();
    await s.svc.approve('s1', inv._id, 'seller');
    expect(sub.currentPeriodEnd.getTime() > end0).toBe(true);
    const end1 = sub.currentPeriodEnd.getTime();
    await s.svc.approve('s1', inv._id, 'seller');
    expect(sub.currentPeriodEnd.getTime()).toBe(end1);
  });

  it('wrong store gets 404, a void invoice cannot be approved, an unsubmitted one can (seller confirms by hand)', async () => {
    const s = setup();
    const sub = await activeSub(s);
    const inv = await invoiceFor(s, sub);
    await expect(s.svc.approve('s2', inv._id, 'x')).rejects.toThrow('Invoice not found');
    await s.svc.approve('s1', inv._id, 'seller');
    expect(inv.status).toBe('paid');
    const s2 = setup();
    const inv2 = await invoiceFor(s2, await activeSub(s2));
    await s2.svc.voidInvoice('s1', inv2._id, 'seller');
    await expect(s2.svc.approve('s1', inv2._id, 'seller')).rejects.toThrow('cancelled');
  });

  it('reject needs a reason and a submitted proof, returns the invoice to the buyer and emails the reason', async () => {
    const s = setup();
    const { inv } = await submitted(s);
    await expect(s.svc.reject('s1', inv._id, 'seller', '  ')).rejects.toThrow('reason');
    await expect(s.svc.reject('s2', inv._id, 'seller', 'no')).rejects.toThrow('Invoice not found');
    await s.svc.reject('s1', inv._id, 'seller', 'Amount does not match');
    expect(inv.status).toBe('awaiting');
    expect(inv.rejectionReason).toBe('Amount does not match');
    expect(inv.rejectionCount).toBe(1);
    expect(mails(s).includes('membership_proof_rejected')).toBe(true);
    expect(s.mailer.membership.mock.calls.find((c: any[]) => c[0] === 'membership_proof_rejected')[5].rejectionReason).toBe('Amount does not match');
    await expect(s.svc.reject('s1', inv._id, 'seller', 'again')).rejects.toThrow('Only a submitted proof');
    // the buyer fixes it and submits again, then the seller approves
    await s.svc.submitProof('s1', 'c1', inv._id, file(), { reference: 'TXN2' });
    expect(inv.status).toBe('submitted');
    await s.svc.approve('s1', inv._id, 'seller');
    expect(inv.status).toBe('paid');
    expect(inv.rejectionReason).toBeNull();
  });

  it('a hand-made "Mark paid" settles the open invoice instead of leaving it dangling', async () => {
    const s = setup();
    const sub = await activeSub(s);
    const inv = await invoiceFor(s, sub);
    await s.memberships.markPaid('s1', sub._id, 'seller');
    expect(inv.status).toBe('paid');
  });
});

describe('overdue -> grace -> revoke', () => {
  it('without proof: access during grace, none after, expiry after the ladder', async () => {
    const s = setup();
    const sub = await activeSub(s, 'c1', 'gold', 1);
    await invoiceFor(s, sub);
    const due = sub.currentPeriodEnd as Date;
    await s.memberships.processRenewals(new Date(due.getTime() + 1000));
    expect(sub.status).toBe('past_due');
    expect(await s.memberships.hasPlanAccess('s1', 'c1', 'gold', new Date(due.getTime() + 1 * DAY))).toBe(true); // grace 2 days
    expect(await s.memberships.hasPlanAccess('s1', 'c1', 'gold', new Date(due.getTime() + 3 * DAY))).toBe(false);
    for (const d of [1, 3, 5, 7, 7]) await s.memberships.processRenewals(new Date(due.getTime() + d * DAY + 1000));
    expect(sub.status).toBe('expired');
    expect((await s.svc.sweep()).voided).toBe(1);
  });

  it('while the seller has not decided on a submitted proof the member is never expired; after a rejection the clock continues', async () => {
    const s = setup();
    const sub = await activeSub(s, 'c1', 'gold', 1);
    const inv = await invoiceFor(s, sub);
    await s.svc.submitProof('s1', 'c1', inv._id, file(), { reference: 'T' });
    const due = sub.currentPeriodEnd as Date;
    await s.memberships.processRenewals(new Date(due.getTime() + 1000));
    for (const d of [1, 3, 5, 7, 7, 9]) await s.memberships.processRenewals(new Date(due.getTime() + d * DAY + 1000));
    expect(sub.status).toBe('past_due'); // waiting for the seller
    await s.svc.reject('s1', inv._id, 'seller', 'Wrong amount');
    for (let i = 0; i < 6; i++) await s.memberships.processRenewals(new Date(due.getTime() + 8 * DAY + i * 3_600_000)); // the hourly job walks the ladder again
    expect(sub.status).toBe('expired');
  });
});

describe('queue for the seller', () => {
  it('lists the open queue by default, filters by status / plan / due date, pages on the server and counts', async () => {
    const s = setup();
    await submitted(s, 'c1');
    const sub2 = await activeSub(s, 'c2', 'silver', 2);
    await invoiceFor(s, sub2);
    const all: any = await s.svc.list('s1', {}, { page: 1, limit: 1, skip: 0 });
    expect(all.total).toBe(2);
    expect(all.items.length).toBe(1);
    expect(all.summary.submitted).toBe(1);
    expect(all.summary.awaiting).toBe(1);
    expect(((await s.svc.list('s1', { status: 'submitted' }, { page: 1, limit: 20, skip: 0 })) as any).items[0].customerName).toBe('Ayesha');
    expect(((await s.svc.list('s1', { planId: 'silver' }, { page: 1, limit: 20, skip: 0 })) as any).total).toBe(1);
    expect(((await s.svc.list('s1', { dueBefore: new Date(Date.now() - DAY).toISOString() }, { page: 1, limit: 20, skip: 0 })) as any).total).toBe(0);
    expect(((await s.svc.list('s2', {}, { page: 1, limit: 20, skip: 0 })) as any).total).toBe(0);
  });

  it('bulk remind sends once per invoice per 12 hours and only inside the store', async () => {
    const s = setup();
    const inv = await invoiceFor(s, await activeSub(s));
    s.mailer.membership.mock.calls.length = 0;
    expect(await s.svc.remind('s1', [inv._id], 'seller')).toEqual({ sent: 1, skipped: 0 });
    expect(await s.svc.remind('s1', [inv._id], 'seller')).toEqual({ sent: 0, skipped: 1 });
    expect(await s.svc.remind('s2', [inv._id], 'seller')).toEqual({ sent: 0, skipped: 1 });
    await expect(s.svc.remind('s1', [], 'seller')).rejects.toThrow('Select at least one');
    expect(s.mailer.membership.mock.calls.length).toBe(1);
  });
});
