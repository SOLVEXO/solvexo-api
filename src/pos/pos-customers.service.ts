/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { isoExponent, toMinor } from '@/common/money-minor.util';
import { PosCustomerCore } from './pos-customer-core.service';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAction } from './pos-permissions.config';
import { POS_REGISTRATION_TYPES } from './schemas/pos-customer.schema';

type Req = any;
interface Tokens { employee?: string; approver?: string }
const rx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const clean = (v: any, max: number): string | null => { const s = (v ?? '').toString().trim(); return s ? s.slice(0, max) : null; };

/**
 * G3.3 — customers at the till: a directory (phone is the natural key; D8 identity fields all optional), a profile (spend, loyalty, store-credit balance), and the helpers the sale path
 * uses inside its transaction: who is this customer for credit / loyalty purposes, earn, redeem, reverse. Credit and loyalty follow `ledgerId`: the linked storefront buyer's
 * user id when there is one (so the balance is shared with the web), else the till customer's own id.
 */
@Injectable()
export class PosCustomersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly pos: PosService,
    private readonly auth: PosAuthorizer,
    private readonly core: PosCustomerCore,
  ) {}
  private get credit() { return this.core.creditService; }
  private resolve(storeId: string, id: string | null | undefined) { return this.core.resolve(storeId, id); }
  private balances(storeId: string, ledgerId: string) { return this.core.balances(storeId, ledgerId); }
  private requireLedger() { this.core.requireLedger(); }
  private get r() { return this.db.repositories; }

  private async gate(req: Req, storeId: string, action: PosAction, t: Tokens, ctx?: any) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    return this.auth.authorize(req, { storeId, action, ctx, employeeToken: t.employee, approverToken: t.approver });
  }
  private async cur(storeId: string) {
    const s: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = String(s?.baseCurrency || 'USD').toUpperCase();
    return { currency, currencyExponent: isoExponent(currency) };
  }
  private audit(storeId: string, employeeId: string | null, action: string, targetId: string | null, metadata: object) {
    return this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'customer', metadata }]);
  }

  // ── directory ───────────────────────────────────────────────────────────────────────────────────────────────────
  private row(c: any, extra: any = {}) {
    return { id: String(c._id), kind: 'pos', name: c.name, phone: c.phone ?? null, email: c.email ?? null, address: c.address ?? null, ntn: c.ntn ?? null, cnic: c.cnic ?? null, registrationType: c.registrationType ?? null, group: c.group ?? null, notes: c.notes ?? null, marketingConsent: !!c.marketingConsent, linkedUserId: c.userId ?? null, createdAt: c.createdAt, ...extra };
  }

  async search(req: Req, storeId: string, q: string, t: Tokens) {
    await this.gate(req, storeId, 'customers.view', t);
    const term = (q ?? '').trim().slice(0, 60);
    const cur = await this.cur(storeId);
    const filter: any = { storeId, isDelete: false };
    if (term) filter.$or = [{ name: rx(term) }, { phone: rx(term) }, { email: rx(term) }];
    const pcs: any[] = await this.r.posCustomerModel.find(filter).sort({ name: 1 }).limit(20).lean();
    const linked = new Set(pcs.map((c) => c.userId).filter(Boolean));
    // storefront buyers of this store that are not (yet) in the till directory — the picker the app already had
    let users: any[] = [];
    if (term) {
      users = await this.r.userModel.find({ storeId, $or: [{ name: rx(term) }, { email: rx(term) }, { phone: rx(term) }] }).select('name email phone').limit(10).lean();
      users = users.filter((u) => !linked.has(String(u._id)));
    }
    const items = [...pcs.map((c) => this.row(c)), ...users.map((u) => ({ id: String(u._id), kind: 'user', name: u.name ?? 'Customer', phone: u.phone ?? null, email: u.email ?? null, address: null, ntn: null, cnic: null, registrationType: null, group: null, notes: null, marketingConsent: false, linkedUserId: String(u._id) }))];
    const withBalance = await Promise.all(items.map(async (c: any) => ({ ...c, ...(await this.balances(storeId, (c.linkedUserId ?? c.id) as string)) })));
    return { success: true, data: { ...cur, items: withBalance } };
  }

  private validate(dto: any, forCreate: boolean) {
    const name = clean(dto?.name, 120);
    if (forCreate && !name) throw new BadRequestException({ statusCode: 400, code: 'NAME_REQUIRED', message: 'A name is required' });
    const phone = dto?.phone === undefined ? undefined : clean((dto.phone ?? '').toString().replace(/[\s()-]/g, ''), 20);
    if (phone && !/^\+?\d{5,18}$/.test(phone)) throw new BadRequestException({ statusCode: 400, code: 'PHONE_INVALID', message: 'Enter the phone number with digits only' });
    const email = dto?.email === undefined ? undefined : clean(dto.email, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException({ statusCode: 400, code: 'EMAIL_INVALID', message: 'That e-mail address does not look right' });
    for (const k of ['ntn', 'cnic']) if (dto?.[k] !== undefined && clean(dto[k], 30) && !/^[A-Za-z0-9-]{1,30}$/.test(clean(dto[k], 30)!)) throw new BadRequestException({ statusCode: 400, code: `${k.toUpperCase()}_INVALID`, message: `${k.toUpperCase()} may contain letters, digits and dashes only` });
    if (dto?.registrationType !== undefined && dto.registrationType !== null && !(POS_REGISTRATION_TYPES as readonly string[]).includes(dto.registrationType)) throw new BadRequestException({ statusCode: 400, code: 'REGISTRATION_TYPE_INVALID', message: 'Registration type must be registered or unregistered' });
    return { name, phone, email };
  }

  async create(req: Req, storeId: string, dto: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'customers.create', t);
    const { name, phone, email } = this.validate(dto, true);
    const phoneN = phone ?? null;
    if (phoneN) { // phone is the key: the same phone returns the customer that already has it (a retry, or the same person at another till)
      const hit: any = await this.r.posCustomerModel.findOne({ storeId, phone: phoneN, isDelete: false }).lean();
      if (hit) return { success: true, message: 'Customer already exists', data: this.row(hit, { existing: true }) };
    }
    const doc: any = {
      storeId, name, phone: phoneN, email: email ?? null, address: clean(dto.address, 300), ntn: clean(dto.ntn, 30), cnic: clean(dto.cnic, 30), registrationType: dto.registrationType ?? null,
      group: clean(dto.group, 60), notes: clean(dto.notes, 500), marketingConsent: dto.marketingConsent === true, userId: null, createdBy: a.employeeId, source: 'pos',
    };
    // linking an existing storefront buyer: only one of THIS store
    if (dto.linkUserId) {
      const u = await this.resolve(storeId, dto.linkUserId);
      if (!u || u.kind !== 'user') throw new BadRequestException({ statusCode: 400, code: 'USER_NOT_FOUND', message: 'That buyer account was not found in this store' });
      doc.userId = u.id;
    }
    let created: any;
    try { created = (await this.r.posCustomerModel.create([doc]))[0]; }
    catch (e: any) {
      if (e?.code === 11000) { const hit: any = await this.r.posCustomerModel.findOne({ storeId, phone: phoneN, isDelete: false }).lean(); if (hit) return { success: true, message: 'Customer already exists', data: this.row(hit, { existing: true }) }; }
      throw e;
    }
    await this.audit(storeId, a.employeeId, 'customer_created', String(created._id), { name, phone: phoneN, role: a.role });
    return { success: true, message: 'Customer added', data: this.row(created.toObject()) };
  }

  async update(req: Req, storeId: string, id: string, dto: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'customers.edit', t);
    const before: any = await this.r.posCustomerModel.findOne({ _id: id, storeId, isDelete: false }).lean();
    if (!before) throw new NotFoundException('Customer not found');
    const { name, phone, email } = this.validate(dto, false);
    const set: any = {};
    if (name) set.name = name;
    if (phone !== undefined) set.phone = phone;
    if (email !== undefined) set.email = email;
    for (const k of ['address', 'group', 'notes']) if (dto[k] !== undefined) set[k] = clean(dto[k], k === 'address' ? 300 : k === 'group' ? 60 : 500);
    for (const k of ['ntn', 'cnic']) if (dto[k] !== undefined) set[k] = clean(dto[k], 30);
    if (dto.registrationType !== undefined) set.registrationType = dto.registrationType ?? null;
    if (dto.marketingConsent !== undefined) set.marketingConsent = dto.marketingConsent === true;
    if (!Object.keys(set).length) return { success: true, data: this.row(before) };
    if (set.phone) { const clash: any = await this.r.posCustomerModel.findOne({ storeId, phone: set.phone, isDelete: false, _id: { $ne: id } }).select('_id').lean(); if (clash) throw new ConflictException({ statusCode: 409, code: 'PHONE_IN_USE', message: 'Another customer already has this phone number' }); }
    const after: any = await this.r.posCustomerModel.findOneAndUpdate({ _id: id, storeId }, { $set: set }, { new: true }).lean();
    const diff = (o: any) => Object.fromEntries(Object.keys(set).map((k) => [k, o?.[k] ?? null]));
    await this.audit(storeId, a.employeeId, 'customer_edited', id, { before: diff(before), after: diff(after), role: a.role });
    return { success: true, data: this.row(after) };
  }

  async profile(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'customers.view', t);
    const c = await this.resolve(storeId, id);
    if (!c) throw new NotFoundException('Customer not found');
    const cur = await this.cur(storeId);
    const pc: any = c.kind === 'pos' ? await this.r.posCustomerModel.findOne({ _id: id, storeId }).lean() : null;
    const matchIds = [...new Set([id, c.ledgerId])];
    const sales: any[] = await this.r.saleModel.find({ storeId, customerId: { $in: matchIds }, status: { $in: ['completed', 'partially_refunded', 'refunded'] } }).sort({ createdAt: -1 }).select('saleNumber total totalMinor refundedAmountMinor status createdAt invoice.number').limit(200).lean();
    const spend = sales.reduce((s, x) => s + Math.max(0, (x.totalMinor ?? toMinor(x.total, cur.currencyExponent)) - (x.refundedAmountMinor ?? 0)), 0);
    const bal = await this.balances(storeId, c.ledgerId);
    const prog: any = await this.r.loyaltyProgramModel.findOne({ storeId }).lean();
    const manager = a.role === 'manager' || a.role === 'owner';
    return { success: true, data: { ...cur, customer: pc ? this.row(pc) : { id, kind: 'user', name: c.name, linkedUserId: c.ledgerId }, ...bal,
      loyalty: { points: bal.loyaltyPoints, tier: bal.loyaltyTier, enabled: !!prog?.isEnabled, earnSpendMinor: prog?.posEarnSpendMinor ?? null, redeemMinorPerPoint: prog?.posRedeemMinorPerPoint ?? null },
      orderCount: sales.length, lastVisitAt: sales[0]?.createdAt ?? null, ...(manager ? { lifetimeSpendMinor: spend } : {}),
      recentSales: sales.slice(0, 10).map((x) => ({ id: String(x._id), number: x.invoice?.number ?? x.saleNumber, totalMinor: x.totalMinor ?? toMinor(x.total, cur.currencyExponent), status: x.status, at: x.createdAt })) } };
  }

  /** Store-credit ledger of a customer (managers); balances are in the profile. */
  async creditLedger(req: Req, storeId: string, id: string, query: any, t: Tokens) {
    await this.gate(req, storeId, 'customers.edit', t);
    const c = await this.resolve(storeId, id);
    if (!c) throw new NotFoundException('Customer not found');
    if (!this.credit || this.credit.mode !== 'new') return { success: true, data: { enabled: false, items: [], ...(await this.cur(storeId)) } };
    const page = Math.max(1, parseInt(query.page) || 1); const limit = Math.min(50, Math.max(1, parseInt(query.limit) || 20));
    const rows: any[] = await this.r.storeCreditEntryModel.find({ storeId, customerId: c.ledgerId }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
    const cur = await this.cur(storeId);
    return { success: true, data: { enabled: true, ...cur, page, items: rows.map((e) => ({ id: String(e._id), at: e.createdAt, type: e.type, amountMinor: Number(e.amountMinor), balanceAfterMinor: Number(e.balanceAfterMinor), note: e.note || null, saleId: e.saleId ?? null, orderId: e.orderId ?? null, creditNoteNumber: e.creditNoteNumber ?? null, expiresAt: e.expiresAt ?? null })) } };
  }

  /** A manager issues / removes credit by hand (above the limit the OWNER must do it). */
  async creditAdjust(req: Req, storeId: string, id: string, dto: { amountMinor: number; note?: string; expiresAt?: string }, t: Tokens) {
    const amountMinor = Number(dto?.amountMinor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) throw new BadRequestException({ statusCode: 400, code: 'AMOUNT_INVALID', message: 'Enter a whole amount in minor units, not zero' });
    const note = clean(dto?.note, 300);
    if (!note) throw new BadRequestException({ statusCode: 400, code: 'NOTE_REQUIRED', message: 'Say why' });
    const a = await this.gate(req, storeId, 'storeCredit.adjust', t, { amountMinor: Math.abs(amountMinor) });
    const c = await this.resolve(storeId, id);
    if (!c) throw new NotFoundException('Customer not found');
    this.requireLedger();
    const cur = await this.cur(storeId);
    const act = { actorId: a.employeeId ?? req.user.userId, actorRole: a.role };
    let balanceMinor: number;
    if (amountMinor > 0) {
      const exp = dto.expiresAt ? new Date(dto.expiresAt) : null;
      if (exp && (isNaN(exp.getTime()) || exp <= new Date())) throw new BadRequestException({ statusCode: 400, code: 'EXPIRY_INVALID', message: 'The expiry date must be in the future' });
      const made: any = await this.credit!.ledger.addLot({ storeId, customerId: c.ledgerId, amountMinor, type: 'adjust_credit', expiresAt: exp, note, actor: act, refs: { approvedBy: a.approvedBy?.employeeId ?? null } });
      balanceMinor = Number(made.entry.balanceAfterMinor);
    } else {
      const res = await this.credit!.ledger.spend({ storeId, customerId: c.ledgerId, amountMinor: -amountMinor, type: 'adjust_debit', note, actor: act, refs: { approvedBy: a.approvedBy?.employeeId ?? null } });
      if (!res.ok) throw new ConflictException({ statusCode: 409, code: 'CREDIT_INSUFFICIENT', message: 'That is more than the customer\'s balance' });
      balanceMinor = Number(res.entry.balanceAfterMinor);
    }
    await this.audit(storeId, a.employeeId, 'store_credit_adjusted', c.ledgerId, { amountMinor, note, role: a.role, approvedBy: a.approvedBy?.employeeId ?? null });
    return { success: true, data: { ...cur, balanceMinor } };
  }

  /** What the till needs to know about this store's customer features (credit tender on/off, loyalty rates). */
  async config(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'customers.view', t);
    const cfg = await this.core.loyaltyConfig(storeId);
    return { success: true, data: { ...(await this.cur(storeId)), storeCreditTenderEnabled: this.core.creditEnabled, loyalty: { enabled: cfg.enabled, earnSpendMinor: cfg.earnSpendMinor, redeemMinorPerPoint: cfg.redeemMinorPerPoint } } };
  }

  /** The owner sets how many minor units of spend earn a point and what a point is worth (null switches that side off). */
  async setLoyaltyConfig(req: Req, storeId: string, dto: { earnSpendMinor?: number | null; redeemMinorPerPoint?: number | null }, t: Tokens) {
    const a = await this.gate(req, storeId, 'loyalty.configure', t);
    const set: any = {};
    for (const k of ['earnSpendMinor', 'redeemMinorPerPoint'] as const) {
      const v = (dto as any)?.[k];
      if (v === undefined) continue;
      if (v !== null && (!Number.isSafeInteger(v) || v < 1)) throw new BadRequestException({ statusCode: 400, code: 'RATE_INVALID', message: `${k} must be a whole number of at least 1, or null to switch it off` });
      set[k === 'earnSpendMinor' ? 'posEarnSpendMinor' : 'posRedeemMinorPerPoint'] = v;
    }
    const before: any = await this.r.loyaltyProgramModel.findOne({ storeId }).select('posEarnSpendMinor posRedeemMinorPerPoint').lean();
    await this.r.loyaltyProgramModel.updateOne({ storeId }, { $set: set, $setOnInsert: { storeId } }, { upsert: true });
    await this.audit(storeId, a.employeeId, 'loyalty_rates_changed', storeId, { before: { posEarnSpendMinor: before?.posEarnSpendMinor ?? null, posRedeemMinorPerPoint: before?.posRedeemMinorPerPoint ?? null }, after: set });
    return this.config(req, storeId, t);
  }
}
