/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { fromMinor, isoExponent, isSafeMinor, toMinor } from '@/common/money-minor.util';
import { refreshExpiredStock } from '../common/expired-stock.util';
import { InventoryService } from '../inventory/inventory.service';
import { SupplierReturnsService } from '../purchase-orders/supplier-returns.service';
import { computeAging } from '../purchase-orders/supplier-aging.util';
import { SUPPLIER_PAYMENT_METHODS } from '../purchase-orders/schemas/supplier-ledger-entry.schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAction } from './pos-permissions.config';
import { recordCashOut } from './pos-cash-out.util';

type Req = any;
interface Tokens { employee?: string; approver?: string }
const err = (status: 400 | 404 | 409, code: string, message: string, extra: object = {}) => {
  const body = { statusCode: status, code, message, ...extra };
  return status === 404 ? new NotFoundException(body) : status === 409 ? new ConflictException(body) : new BadRequestException(body);
};
const pad = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;
const RECEIVABLE = ['approved', 'sent', 'partially_received'];
const EDITABLE = ['draft', 'approved', 'sent'];
const str = (v: any, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const minorOf = (v: any, field: string, { allowZero = true }: { allowZero?: boolean } = {}): number => {
  if (!isSafeMinor(v) || v < 0 || (!allowZero && v === 0)) throw err(400, 'INVALID_AMOUNT', `${field} must be a whole number of minor units${allowZero ? ' (0 or more)' : ' above 0'}`);
  return v;
};
const qtyOf = (v: any, field: string, min = 0): number => {
  if (!Number.isInteger(v) || v < min) throw err(400, 'INVALID_QUANTITY', `${field} must be a whole number${min ? ` of at least ${min}` : ' (0 or more)'}`);
  return v;
};

/**
 * G3.4 — Supply for the till: suppliers, purchase orders (draft → approved → sent → partially received → received / cancelled), goods receipts, supplier returns,
 * payables and supplier payments. A facade over the existing `purchase-orders` data (the dashboard and the till see the SAME suppliers and POs), behind the
 * permission matrix. Every NEW money value is integer minor units; every response that carries money states its currency + exponent.
 * Costs, payables and payments are manager / owner only; a cashier sees approved POs without any cost and may receive against them when the matrix allows.
 */
@Injectable()
export class PosSupplyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly pos: PosService,
    private readonly auth: PosAuthorizer,
    private readonly inventory: InventoryService,
    private readonly returns: SupplierReturnsService,
  ) {}
  private get r(): any { return this.db.repositories; }

  private async gate(req: Req, storeId: string, action: PosAction, t: Tokens, ctx?: Parameters<PosAuthorizer['authorize']>[1]['ctx']) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    return this.auth.authorize(req, { storeId, action, ctx, employeeToken: t.employee, approverToken: t.approver });
  }
  private async cur(storeId: string): Promise<{ currency: string; currencyExponent: number }> {
    const s: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = String(s?.baseCurrency || 'USD').toUpperCase();
    return { currency, currencyExponent: isoExponent(currency) };
  }
  private audit(storeId: string, employeeId: string | null, action: string, targetId: string | null, metadata: object, tx?: ClientSession) {
    return this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'supply', metadata }], tx ? { session: tx } : undefined);
  }
  private deviceOf = (req: Req): string | null => req?.user?.posDevice?.deviceId ?? null;
  private atomic<T>(fn: (tx: ClientSession) => Promise<T>): Promise<T> { return this.r.purchaseOrderModel.db.transaction(fn); }
  private async ensureSettings(storeId: string) { await this.r.posSettingsModel.updateOne({ storeId }, { $setOnInsert: { storeId } }, { upsert: true }); }
  private async nextSeq(storeId: string, field: 'poCounter' | 'receiptCounter', tx: ClientSession): Promise<number> {
    const s: any = await this.r.posSettingsModel.findOneAndUpdate({ storeId }, { $inc: { [field]: 1 } }, { new: true, upsert: true, session: tx });
    return Number(s[field]);
  }

  // ── views ─────────────────────────────────────────────────────────────────────
  private supplierView(s: any, extra: object = {}) {
    return { id: String(s._id), name: s.name, contactName: s.contactName ?? null, phone: s.phone ?? null, email: s.email ?? null, address: s.address ?? null, ntn: s.ntn ?? null, strn: s.strn ?? null, paymentTerms: s.paymentTerms ?? null, leadTimeDays: s.leadTimeDays ?? null, notes: s.notes ?? null, status: s.status, ...extra };
  }
  private poView(po: any, exp: number, costs: boolean, lotVariants?: Set<string>) {
    const items = (po.items ?? []).map((i: any) => {
      const unitCostMinor = i.unitCostMinor ?? toMinor(i.unitCost ?? 0, exp);
      const done = (i.quantityReceived ?? 0) + (i.quantityDamaged ?? 0);
      return {
        id: String(i._id), productId: i.productId, variantId: i.variantId, name: i.name, sku: i.sku ?? null, image: i.image ?? null, options: i.options ?? [],
        trackLots: lotVariants?.has(String(i.variantId)) ?? false,
        quantityOrdered: i.quantityOrdered, quantityReceived: i.quantityReceived ?? 0, quantityDamaged: i.quantityDamaged ?? 0, quantityReturned: i.quantityReturned ?? 0, quantityRemaining: Math.max(0, i.quantityOrdered - done),
        ...(costs ? { unitCostMinor, lineTotalMinor: unitCostMinor * i.quantityOrdered } : {}),
      };
    });
    return {
      id: String(po._id), poNumber: po.poNumber, status: po.status, supplierId: po.supplierId ?? null, supplierName: po.supplierName, locationId: po.locationId ?? null, expectedAt: po.expectedAt ?? null, notes: po.notes ?? '',
      approvedBy: po.approvedBy ?? null, approvedAt: po.approvedAt ?? null, sentAt: po.sentAt ?? null, receivedAt: po.receivedAt ?? null, createdAt: po.createdAt ?? null, currency: po.currency, currencyExponent: exp,
      editable: EDITABLE.includes(po.status), items,
      ...(costs ? { subtotalMinor: po.subtotalMinor ?? toMinor(po.subtotal ?? 0, exp), shippingMinor: po.shippingCostMinor ?? toMinor(po.shippingCost ?? 0, exp), taxMinor: po.taxCostMinor ?? toMinor(po.taxCost ?? 0, exp), totalMinor: po.totalMinor ?? toMinor(po.total ?? 0, exp) } : {}),
    };
  }
  private receiptView(rc: any, costs: boolean) {
    return {
      id: String(rc._id), receiptNumber: rc.receiptNumber, purchaseOrderId: rc.purchaseOrderId ?? null, poNumber: rc.poNumber ?? null, supplierId: rc.supplierId ?? null, supplierName: rc.supplierName, locationId: rc.locationId ?? null,
      supplierInvoiceNumber: rc.supplierInvoiceNumber ?? null, supplierInvoiceDate: rc.supplierInvoiceDate ?? null, note: rc.note ?? null, createdAt: rc.createdAt ?? null, currency: rc.currency, currencyExponent: rc.currencyExponent,
      lines: (rc.lines ?? []).map((l: any) => ({ id: String(l._id), poItemId: l.poItemId ?? null, variantId: l.variantId, productId: l.productId, name: l.name, sku: l.sku ?? null, qtyGood: l.qtyGood, qtyDamaged: l.qtyDamaged ?? 0, lotId: l.lotId ?? null, lotNumber: l.lotNumber ?? null, expiryDate: l.expiryDate ?? null, ...(costs ? { unitCostMinor: l.unitCostMinor, lineTotalMinor: l.lineTotalMinor } : {}) })),
      ...(costs ? { totalMinor: rc.totalMinor } : {}),
    };
  }
  private async balanceOf(storeId: string, supplierId: string, tx?: ClientSession): Promise<number> {
    const agg = this.r.supplierLedgerEntryModel.aggregate([{ $match: { storeId, supplierId } }, { $group: { _id: null, t: { $sum: '$amountMinor' } } }]);
    if (tx) agg.session(tx);
    return (await agg)[0]?.t ?? 0;
  }
  private async agingOf(storeId: string, supplierId: string) {
    const rows: any[] = await this.r.supplierLedgerEntryModel.find({ storeId, supplierId }).select('type amountMinor createdAt supplierInvoiceDate').lean();
    return computeAging(rows.map((e) => ({ type: e.type, amountMinor: e.amountMinor, at: e.type === 'bill' && e.supplierInvoiceDate ? e.supplierInvoiceDate : e.createdAt })));
  }
  private async loadSupplier(storeId: string, id: string, tx?: ClientSession): Promise<any> {
    if (!Types.ObjectId.isValid(id)) throw err(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
    const q = this.r.supplierModel.findOne({ _id: id, storeId, isDelete: false });
    const s: any = await (tx ? q.session(tx) : q);
    if (!s) throw err(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
    return s;
  }
  private async loadPo(storeId: string, id: string, tx?: ClientSession): Promise<any> {
    if (!Types.ObjectId.isValid(id)) throw err(404, 'PO_NOT_FOUND', 'Purchase order not found');
    const q = this.r.purchaseOrderModel.findOne({ _id: id, storeId });
    const po: any = await (tx ? q.session(tx) : q);
    if (!po) throw err(404, 'PO_NOT_FOUND', 'Purchase order not found');
    return po;
  }

  // ── suppliers ─────────────────────────────────────────────────────────────────
  async suppliers(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'supply.view', t);
    const rows: any[] = await this.r.supplierModel.find({ storeId, isDelete: false, status: 'active' }).sort({ name: 1 }).lean();
    const bal: any[] = await this.r.supplierLedgerEntryModel.aggregate([{ $match: { storeId } }, { $group: { _id: '$supplierId', t: { $sum: '$amountMinor' } } }]);
    const open: any[] = await this.r.purchaseOrderModel.aggregate([{ $match: { storeId, status: { $in: ['draft', 'approved', 'sent', 'partially_received'] } } }, { $group: { _id: '$supplierId', c: { $sum: 1 } } }]);
    const b = new Map(bal.map((x) => [String(x._id), x.t])); const o = new Map(open.map((x) => [String(x._id), x.c]));
    return { success: true, data: { ...(await this.cur(storeId)), suppliers: rows.map((s) => this.supplierView(s, { balanceMinor: b.get(String(s._id)) ?? 0, openOrders: o.get(String(s._id)) ?? 0 })) } };
  }
  async supplier(req: Req, storeId: string, id: string, t: Tokens) {
    await this.gate(req, storeId, 'supply.view', t);
    const s = await this.loadSupplier(storeId, id);
    const [aging, pos, receipts] = await Promise.all([
      this.agingOf(storeId, id),
      this.r.purchaseOrderModel.find({ storeId, supplierId: id }).sort({ createdAt: -1 }).limit(10).lean(),
      this.r.purchaseReceiptModel.find({ storeId, supplierId: id }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    const c = await this.cur(storeId);
    return { success: true, data: { ...c, supplier: this.supplierView(s), aging, orders: (pos as any[]).map((p) => this.poView(p, c.currencyExponent, true)), receipts: (receipts as any[]).map((x) => this.receiptView(x, true)) } };
  }
  private supplierFields(b: any, partial: boolean) {
    const out: Record<string, any> = {};
    const set = (k: string, v: any) => { if (!partial || v !== undefined) out[k] = v; };
    const text = (k: string, max: number) => { if (b?.[k] !== undefined || !partial) set(k, str(b?.[k], max)); };
    text('name', 120); text('contactName', 120); text('phone', 40); text('email', 160); text('address', 300); text('paymentTerms', 120); text('notes', 500); text('ntn', 40); text('strn', 40);
    if (b?.leadTimeDays !== undefined) set('leadTimeDays', b.leadTimeDays === null ? null : Math.max(0, Math.round(Number(b.leadTimeDays) || 0)));
    return out;
  }
  async createSupplier(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.write', t);
    const f = this.supplierFields(body, false);
    if (!f.name) throw err(400, 'NAME_REQUIRED', 'A supplier needs a name');
    const doc = await this.r.supplierModel.create({ ...f, storeId, sellerId: req.user.userId, status: 'active' });
    await this.audit(storeId, a.employeeId, 'supplier_created', String(doc._id), { name: f.name });
    return { success: true, data: { supplier: this.supplierView(doc) } };
  }
  async updateSupplier(req: Req, storeId: string, id: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.write', t);
    await this.loadSupplier(storeId, id);
    const f = this.supplierFields(body, true);
    if ('name' in f && !f.name) throw err(400, 'NAME_REQUIRED', 'A supplier needs a name');
    const doc = await this.r.supplierModel.findOneAndUpdate({ _id: id, storeId }, { $set: f }, { new: true });
    await this.audit(storeId, a.employeeId, 'supplier_updated', id, { fields: Object.keys(f) });
    return { success: true, data: { supplier: this.supplierView(doc) } };
  }

  // ── purchase orders ───────────────────────────────────────────────────────────
  async orders(req: Req, storeId: string, q: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.receive', t); // everyone who may receive may see the list; costs only for managers
    const costs = a.role !== 'cashier';
    const filter: any = { storeId };
    if (!costs) filter.status = { $in: RECEIVABLE };
    else if (q?.status && q.status !== 'all') filter.status = String(q.status);
    if (q?.supplierId) filter.supplierId = String(q.supplierId);
    const rows: any[] = await this.r.purchaseOrderModel.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(q?.limit) || 100, 200)).lean();
    const c = await this.cur(storeId);
    return { success: true, data: { ...c, orders: rows.map((p) => this.poView(p, c.currencyExponent, costs)) } };
  }
  async order(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.receive', t);
    const po = await this.loadPo(storeId, id);
    const costs = a.role !== 'cashier';
    if (!costs && !RECEIVABLE.includes(po.status)) throw err(404, 'PO_NOT_FOUND', 'Purchase order not found');
    const c = await this.cur(storeId);
    const receipts: any[] = await this.r.purchaseReceiptModel.find({ storeId, purchaseOrderId: id }).sort({ createdAt: 1 }).lean();
    const lotRows: any[] = await this.r.productVariantModel.find({ _id: { $in: po.items.map((i: any) => i.variantId) }, trackLots: true }).select('_id').lean();
    const lots = new Set(lotRows.map((v) => String(v._id)));
    return { success: true, data: { ...c, order: this.poView(po.toObject ? po.toObject() : po, c.currencyExponent, costs, lots), receipts: receipts.map((x) => this.receiptView(x, costs)) } };
  }
  private async resolveLines(storeId: string, items: any, exp: number) {
    if (!Array.isArray(items) || items.length === 0) throw err(400, 'ITEMS_REQUIRED', 'A purchase order needs at least one line');
    const seen = new Set<string>();
    const out: any[] = [];
    for (const it of items) {
      const variantId = String(it?.variantId ?? '');
      if (!Types.ObjectId.isValid(variantId)) throw err(400, 'VARIANT_REQUIRED', 'Each line needs a product variant');
      if (seen.has(variantId)) throw err(400, 'DUPLICATE_LINE', 'The same product appears twice — combine the quantities into one line');
      seen.add(variantId);
      const quantityOrdered = qtyOf(it.quantityOrdered, 'quantityOrdered', 1);
      const unitCostMinor = minorOf(it.unitCostMinor, 'unitCostMinor');
      const v: any = await this.r.productVariantModel.findOne({ _id: variantId, isDelete: false }).lean();
      const p: any = v ? await this.r.productModel.findOne({ _id: v.productId, storeId, isDelete: false }).select('name images').lean() : null;
      if (!v || !p) throw err(404, 'VARIANT_NOT_FOUND', 'A product on this purchase order was not found in your store');
      out.push({ productId: v.productId, variantId, name: p.name, image: p.images?.[0] ?? null, sku: v.sku ?? null, options: v.options ?? [], quantityOrdered, quantityReceived: 0, quantityDamaged: 0, quantityReturned: 0, unitCost: fromMinor(unitCostMinor, exp) });
    }
    return out;
  }
  private totalsOf(items: any[], shippingMinor: number, taxMinor: number, exp: number) {
    const subtotalMinor = items.reduce((s, i) => s + toMinor(i.unitCost, exp) * i.quantityOrdered, 0);
    return { subtotalMinor, totalMinor: subtotalMinor + shippingMinor + taxMinor, subtotal: fromMinor(subtotalMinor, exp), shippingCost: fromMinor(shippingMinor, exp), taxCost: fromMinor(taxMinor, exp), total: fromMinor(subtotalMinor + shippingMinor + taxMinor, exp) };
  }
  private async supplierRef(storeId: string, b: any, existing?: { supplierId: string | null; supplierName: string }) {
    if (b?.supplierId !== undefined && b.supplierId !== null) { const s = await this.loadSupplier(storeId, String(b.supplierId)); return { supplierId: String(s._id), supplierName: s.name }; }
    if (existing && b?.supplierId === undefined) return existing;
    throw err(400, 'SUPPLIER_REQUIRED', 'Choose a supplier');
  }
  async createOrder(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.write', t);
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const sup = await this.supplierRef(storeId, body);
    const items = await this.resolveLines(storeId, body?.items, exp);
    const shippingMinor = minorOf(body?.shippingMinor ?? 0, 'shippingMinor'); const taxMinor = minorOf(body?.taxMinor ?? 0, 'taxMinor');
    if (body?.locationId) { const loc = await this.r.storeLocationModel.findOne({ _id: body.locationId, storeId, isDelete: false }).lean(); if (!loc) throw err(404, 'LOCATION_NOT_FOUND', 'Location not found'); }
    await this.ensureSettings(storeId);
    const tot = this.totalsOf(items, shippingMinor, taxMinor, exp);
    const po: any = await this.atomic(async (tx) => {
      const seq = await this.nextSeq(storeId, 'poCounter', tx);
      const [doc] = await this.r.purchaseOrderModel.create([{
        storeId, sellerId: req.user.userId, ...sup, locationId: body?.locationId ?? null, items, status: 'draft', notes: str(body?.notes, 1000) ?? '', currency, subtotal: tot.subtotal, shippingCost: tot.shippingCost, taxCost: tot.taxCost, total: tot.total,
        poNumber: pad('PO', seq), seq, expectedAt: body?.expectedAt ? new Date(body.expectedAt) : null, createdBy: a.employeeId ?? req.user.userId,
      }], { session: tx });
      await this.audit(storeId, a.employeeId, 'po_created', String(doc._id), { poNumber: doc.poNumber, totalMinor: tot.totalMinor }, tx);
      return doc;
    });
    return { success: true, data: { ...(await this.cur(storeId)), order: this.poView(po.toObject(), exp, true) } };
  }
  private async receiptCount(storeId: string, poId: string): Promise<number> { return this.r.purchaseReceiptModel.countDocuments({ storeId, purchaseOrderId: poId }); }
  /** Edits are allowed only before any receiving started; an approved / sent PO that is edited goes back to draft and needs approving again. */
  async updateOrder(req: Req, storeId: string, id: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.write', t);
    const { currencyExponent: exp } = await this.cur(storeId);
    const po = await this.loadPo(storeId, id);
    if (!EDITABLE.includes(po.status) || (await this.receiptCount(storeId, id)) > 0) throw err(409, 'PO_NOT_EDITABLE', 'Receiving has started on this purchase order — create a new one for the rest.');
    const set: any = { status: 'draft', approvedBy: null, approvedAt: null, sentAt: null };
    if (body?.supplierId !== undefined) Object.assign(set, await this.supplierRef(storeId, body));
    if (body?.notes !== undefined) set.notes = str(body.notes, 1000) ?? '';
    if (body?.expectedAt !== undefined) set.expectedAt = body.expectedAt ? new Date(body.expectedAt) : null;
    if (body?.locationId !== undefined) set.locationId = body.locationId || null;
    let items = po.items.map((i: any) => i.toObject());
    if (body?.items !== undefined) { items = await this.resolveLines(storeId, body.items, exp); set.items = items; }
    const shippingMinor = body?.shippingMinor !== undefined ? minorOf(body.shippingMinor, 'shippingMinor') : (po.shippingCostMinor ?? toMinor(po.shippingCost, exp));
    const taxMinor = body?.taxMinor !== undefined ? minorOf(body.taxMinor, 'taxMinor') : (po.taxCostMinor ?? toMinor(po.taxCost, exp));
    const tot = this.totalsOf(items, shippingMinor, taxMinor, exp);
    Object.assign(set, { subtotal: tot.subtotal, shippingCost: tot.shippingCost, taxCost: tot.taxCost, total: tot.total });
    po.set(set);
    await po.save(); // the pre-validate hook re-derives every minor twin from the new decimals
    await this.audit(storeId, a.employeeId, 'po_updated', id, { fields: Object.keys(body ?? {}) });
    return { success: true, data: { ...(await this.cur(storeId)), order: this.poView(po.toObject(), exp, true) } };
  }
  async approveOrder(req: Req, storeId: string, id: string, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const { currencyExponent: exp } = await this.cur(storeId);
    const po = await this.loadPo(storeId, id);
    if (po.status !== 'draft') throw err(409, 'PO_NOT_DRAFT', `Only a draft purchase order can be approved (this one is "${po.status}").`);
    const totalMinor = po.totalMinor ?? toMinor(po.total, exp);
    const a = await this.gate(req, storeId, 'supply.po.approve', t, { amountMinor: totalMinor }); // above the store's limit the OWNER approves (D6)
    const by = a.approvedBy?.employeeId ?? a.employeeId ?? 'owner';
    const hit = await this.r.purchaseOrderModel.findOneAndUpdate({ _id: id, storeId, status: 'draft' }, { $set: { status: 'approved', approvedBy: by, approvedAt: new Date() } }, { new: true });
    if (!hit) throw err(409, 'PO_NOT_DRAFT', 'This purchase order is no longer a draft.');
    await this.audit(storeId, a.employeeId, 'po_approved', id, { poNumber: po.poNumber, totalMinor, approvedBy: by, requestedBy: a.employeeId });
    return { success: true, data: { ...(await this.cur(storeId)), order: this.poView(hit.toObject(), exp, true) } };
  }
  async sendOrder(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.write', t);
    const { currencyExponent: exp } = await this.cur(storeId);
    const hit = await this.r.purchaseOrderModel.findOneAndUpdate({ _id: id, storeId, status: 'approved' }, { $set: { status: 'sent', sentAt: new Date() } }, { new: true });
    if (!hit) throw err(409, 'PO_NOT_APPROVED', 'Only an approved purchase order can be sent.');
    await this.audit(storeId, a.employeeId, 'po_sent', id, { poNumber: hit.poNumber });
    return { success: true, data: { ...(await this.cur(storeId)), order: this.poView(hit.toObject(), exp, true) } };
  }
  async cancelOrder(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.write', t);
    const { currencyExponent: exp } = await this.cur(storeId);
    const po = await this.loadPo(storeId, id);
    if (!EDITABLE.includes(po.status) || (await this.receiptCount(storeId, id)) > 0) throw err(409, 'PO_NOT_CANCELLABLE', 'Receiving has started — close the order short instead.');
    const hit = await this.r.purchaseOrderModel.findOneAndUpdate({ _id: id, storeId, status: { $in: EDITABLE } }, { $set: { status: 'cancelled', cancelledAt: new Date() } }, { new: true });
    if (!hit) throw err(409, 'PO_NOT_CANCELLABLE', 'This purchase order can no longer be cancelled.');
    await this.audit(storeId, a.employeeId, 'po_cancelled', id, { poNumber: po.poNumber });
    return { success: true, data: { ...(await this.cur(storeId)), order: this.poView(hit.toObject(), exp, true) } };
  }
  async closeShort(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.po.write', t);
    const { currencyExponent: exp } = await this.cur(storeId);
    const hit = await this.r.purchaseOrderModel.findOneAndUpdate({ _id: id, storeId, status: 'partially_received' }, { $set: { status: 'closed_short', receivedAt: new Date() } }, { new: true });
    if (!hit) throw err(409, 'PO_NOT_PARTIAL', 'Only a partially received purchase order can be closed short.');
    await this.audit(storeId, a.employeeId, 'po_closed_short', id, { poNumber: hit.poNumber });
    return { success: true, data: { ...(await this.cur(storeId)), order: this.poView(hit.toObject(), exp, true) } };
  }

  // ── receiving ─────────────────────────────────────────────────────────────────
  /**
   * One goods receipt = ONE transaction: stock, location rows, lots, stock adjustments (which write the stock-ledger movements), the weighted-average cost, the PO line counters,
   * the receipt document and the supplier BILL commit together or not at all. Two tills receiving the same PO line contend on the PO's `receiptRev` write; the loser re-reads
   * and the per-line cap (received + damaged ≤ ordered, strictly) refuses an over-receipt. A retry with the same `requestId` returns the original receipt.
   * Weighted average (D5), in minor units of the store currency: new = round((on-hand × cost + received × unit) / (on-hand + received)); no cost yet → the unit cost.
   */
  async receive(req: Req, storeId: string, body: any, t: Tokens) {
    const direct = !body?.purchaseOrderId;
    const a = await this.gate(req, storeId, direct ? 'supply.receive.direct' : 'supply.po.receive', t);
    const costs = a.role !== 'cashier';
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const requestId = str(body?.requestId, 100);
    if (requestId) {
      const dup: any = await this.r.purchaseReceiptModel.findOne({ storeId, requestId }).lean();
      if (dup) return { success: true, data: { ...(await this.cur(storeId)), receipt: this.receiptView(dup, costs), order: null as any, duplicate: true } };
    }
    if (!Array.isArray(body?.lines) || body.lines.length === 0) throw err(400, 'LINES_REQUIRED', 'Nothing to receive');
    const seen = new Set<string>();
    const lines = body.lines.map((l: any) => {
      const key = direct ? String(l?.variantId ?? '') : String(l?.poItemId ?? '');
      if (!key) throw err(400, 'LINE_REQUIRED', direct ? 'Each line needs a variant' : 'Each line needs its purchase-order line');
      if (seen.has(key)) throw err(400, 'DUPLICATE_LINE', 'Each line can appear only once per receipt');
      seen.add(key);
      const qtyGood = qtyOf(l.qtyGood ?? 0, 'qtyGood'); const qtyDamaged = qtyOf(l.qtyDamaged ?? 0, 'qtyDamaged');
      if (qtyGood + qtyDamaged === 0) throw err(400, 'INVALID_QUANTITY', 'A receipt line needs a quantity');
      if (direct) minorOf(l.unitCostMinor, 'unitCostMinor');
      else if (l.unitCostMinor !== undefined && !costs) throw err(400, 'COST_NOT_ALLOWED', 'A cashier receives at the purchase-order cost.');
      return { ...l, key, qtyGood, qtyDamaged };
    });
    await this.ensureSettings(storeId);
    let supplier: any = null;
    if (direct) { if (!body?.supplierId) throw err(400, 'SUPPLIER_REQUIRED', 'Choose the supplier this stock came from'); supplier = await this.loadSupplier(storeId, String(body.supplierId)); }
    // location rows must exist before a location-specific receipt (idempotent; outside the transaction like the dashboard path)
    const preLoc: string | null = direct ? (body?.locationId ?? null) : ((await this.loadPo(storeId, String(body.purchaseOrderId))) as any).locationId ?? null;
    if (preLoc) {
      for (const l of lines) {
        const poItemVariant = direct ? l.variantId : ((await this.loadPo(storeId, String(body.purchaseOrderId))).items.id(l.poItemId)?.variantId);
        const v: any = poItemVariant ? await this.r.productVariantModel.findOne({ _id: poItemVariant, isDelete: false }) : null;
        if (v) await this.inventory.ensureLocationStockSeeded(storeId, String(v._id), v);
      }
    }
    let saved: any;
    try {
      saved = await this.atomic(async (tx) => {
        let po: any = null;
        if (!direct) {
          await this.r.purchaseOrderModel.updateOne({ _id: body.purchaseOrderId, storeId }, { $inc: { receiptRev: 1 } }, { session: tx }); // take the write lock first: a racing receipt retries on the new state
          po = await this.loadPo(storeId, String(body.purchaseOrderId), tx);
          if (!RECEIVABLE.includes(po.status)) throw err(409, 'PO_NOT_RECEIVABLE', `Cannot receive against a purchase order that is "${po.status}" — it must be approved first.`);
        }
        const locationId: string | null = direct ? (body?.locationId ?? null) : po.locationId ?? null;
        const supplierId: string | null = direct ? String(supplier._id) : po.supplierId ?? null;
        const supplierName: string = direct ? supplier.name : po.supplierName;
        const receiptId = new Types.ObjectId();
        const seq = await this.nextSeq(storeId, 'receiptCounter', tx);
        const receiptNumber = pad('GRN', seq);
        const docLines: any[] = [];
        let totalMinor = 0;
        for (const l of lines) {
          const item = direct ? null : po.items.id(l.poItemId);
          if (!direct && !item) throw err(400, 'LINE_NOT_FOUND', 'A line does not belong to this purchase order');
          const variantId = direct ? String(l.variantId) : item.variantId;
          const variant: any = await this.r.productVariantModel.findOne({ _id: variantId, isDelete: false }).session(tx);
          if (!variant) throw err(404, 'VARIANT_NOT_FOUND', 'A product on this receipt no longer exists');
          const product: any = await this.r.productModel.findOne({ _id: variant.productId, storeId, isDelete: false }).select('name').session(tx).lean();
          if (!product) throw err(404, 'VARIANT_NOT_FOUND', 'A product on this receipt is not in your store');
          if (variant.trackSerials) throw err(400, 'SERIALS_NOT_SUPPORTED', `${product.name} is serial-tracked — receive it from the dashboard so each serial number is recorded.`);
          if (variant.unlimitedStock) throw err(400, 'UNLIMITED_STOCK', `${product.name} has unlimited stock — nothing to receive`);
          const good = l.qtyGood, damaged = l.qtyDamaged, total = good + damaged;
          // strict per-line cap on a PO receipt (the dashboard path tolerates over-shipping and logs it; the till does not)
          if (item) {
            const done = (item.quantityReceived ?? 0) + (item.quantityDamaged ?? 0);
            if (done + total > item.quantityOrdered) throw err(409, 'OVER_RECEIPT', `${item.name}: only ${Math.max(0, item.quantityOrdered - done)} more can be received on this purchase order.`, { remaining: Math.max(0, item.quantityOrdered - done) });
          }
          const unitMinor: number = item ? (item.unitCostMinor ?? toMinor(item.unitCost, exp)) : l.unitCostMinor;
          if (variant.trackLots && good > 0 && !str(l.lotNumber, 80)) throw err(400, 'LOT_REQUIRED', `${product.name} tracks lots — enter the lot number from the supplier's delivery.`);
          const onHand = variant.stock ?? 0;
          const prevMinor: number | null = variant.costPriceMinor ?? (variant.costPrice != null ? toMinor(variant.costPrice, exp) : null);
          const newMinor = prevMinor == null || onHand <= 0 ? unitMinor : Math.round((onHand * prevMinor + good * unitMinor) / (onHand + good));
          // a damaged-only line does not change the average (those units are claimed back); a good receipt re-weights it
          const avgMinor = good > 0 ? newMinor : (prevMinor ?? unitMinor);

          if (good > 0 && locationId) {
            await this.inventory.ensureLocationStockSeeded(storeId, variantId, variant);
            await this.r.variantLocationStockModel.updateOne({ variantId, locationId }, { $inc: { stock: good }, $setOnInsert: { storeId, productId: variant.productId } }, { upsert: true, session: tx });
          }
          await this.r.productVariantModel.updateOne({ _id: variantId }, { $inc: { stock: total, damagedStock: damaged }, $set: { costPrice: fromMinor(avgMinor, exp), costPriceMinor: avgMinor } }, { session: tx });

          let lotId: string | null = null; const lotNumber = str(l.lotNumber, 80);
          if (variant.trackLots && good > 0) {
            const expiry = l.expiryDate ? new Date(l.expiryDate) : null;
            if (expiry && Number.isNaN(expiry.getTime())) throw err(400, 'INVALID_EXPIRY', 'The expiry date is not a valid date');
            const [lot] = await this.r.stockLotModel.create([{
              storeId, productId: variant.productId, variantId, locationId, lotNumber, expiryDate: expiry, quantityReceived: good, quantityRemaining: good,
              costPrice: fromMinor(unitMinor, exp), costPriceMinor: unitMinor, supplierId, purchaseOrderId: po ? String(po._id) : null, receiptId: String(receiptId), status: 'active',
            }], { session: tx });
            lotId = String(lot._id);
            if (expiry) await refreshExpiredStock(this.r, variantId, { session: tx });
          }
          if (good > 0) {
            await this.r.stockAdjustmentModel.create([{
              unitCostMinor: unitMinor, storeId, productId: variant.productId, variantId, locationId, productName: product.name, sku: variant.sku ?? null,
              previousStock: onHand, newStock: onHand + good, delta: good, reason: 'purchase_received', note: `${receiptNumber}${po ? ` · PO ${po.poNumber}` : ' · no purchase order'}`, adjustedBy: a.employeeId ?? req.user.userId, adjustedByName: null,
            }], { session: tx });
          }
          if (damaged > 0) {
            await this.r.stockAdjustmentModel.create([{
              storeId, productId: variant.productId, variantId, locationId: null, productName: product.name, sku: variant.sku ?? null,
              previousStock: onHand + good, newStock: onHand + total, delta: damaged, reason: 'damaged', note: `Damaged on arrival — ${receiptNumber}`, adjustedBy: a.employeeId ?? req.user.userId, adjustedByName: null,
            }], { session: tx });
          }
          if (item) { item.quantityReceived = (item.quantityReceived ?? 0) + good; item.quantityDamaged = (item.quantityDamaged ?? 0) + damaged; }
          const lineTotalMinor = total * unitMinor;
          totalMinor += lineTotalMinor;
          docLines.push({ poItemId: item ? String(item._id) : null, productId: variant.productId, variantId, name: product.name, sku: variant.sku ?? null, qtyGood: good, qtyDamaged: damaged, unitCostMinor: unitMinor, lineTotalMinor, lotId, lotNumber: lotNumber ?? null, expiryDate: l.expiryDate ? new Date(l.expiryDate) : null });
        }
        if (po) {
          const fully = (po.items as any[]).every((i) => (i.quantityReceived + i.quantityDamaged) >= i.quantityOrdered);
          po.status = fully ? 'received' : 'partially_received';
          if (fully) po.receivedAt = new Date();
          await po.save({ session: tx });
        }
        const invDate = body?.supplierInvoiceDate ? new Date(body.supplierInvoiceDate) : null;
        if (invDate && Number.isNaN(invDate.getTime())) throw err(400, 'INVALID_DATE', 'The supplier invoice date is not a valid date');
        const [rc] = await this.r.purchaseReceiptModel.create([{
          _id: receiptId, storeId, receiptNumber, seq, purchaseOrderId: po ? String(po._id) : null, poNumber: po?.poNumber ?? null, supplierId, supplierName, locationId, lines: docLines, currency, currencyExponent: exp, totalMinor,
          supplierInvoiceNumber: str(body?.supplierInvoiceNumber, 80), supplierInvoiceDate: invDate, note: str(body?.note, 500), requestId, employeeId: a.employeeId, deviceId: this.deviceOf(req),
        }], { session: tx });
        if (supplierId && totalMinor > 0) {
          await this.r.supplierLedgerEntryModel.create([{
            storeId, supplierId, type: 'bill', amountMinor: totalMinor, currency, currencyExponent: exp, refType: 'receipt', refId: String(receiptId), refNumber: receiptNumber, purchaseOrderId: po ? String(po._id) : null,
            supplierInvoiceNumber: str(body?.supplierInvoiceNumber, 80), supplierInvoiceDate: invDate, employeeId: a.employeeId, deviceId: this.deviceOf(req), dedupeKey: `receipt:${String(receiptId)}`,
          }], { session: tx });
        }
        await this.audit(storeId, a.employeeId, 'goods_received', String(receiptId), { receiptNumber, poNumber: po?.poNumber ?? null, totalMinor, lines: docLines.length }, tx);
        return { rc, po };
      });
    } catch (e: any) {
      if (e?.code === 11000 && requestId) {
        const dup: any = await this.r.purchaseReceiptModel.findOne({ storeId, requestId }).lean();
        if (dup) return { success: true, data: { ...(await this.cur(storeId)), receipt: this.receiptView(dup, costs), order: null as any, duplicate: true } };
      }
      throw e;
    }
    return { success: true, data: { ...(await this.cur(storeId)), receipt: this.receiptView(saved.rc.toObject(), costs), order: saved.po ? this.poView(saved.po.toObject(), exp, costs) : null, duplicate: false } };
  }
  async receipts(req: Req, storeId: string, q: any, t: Tokens) {
    await this.gate(req, storeId, 'supply.costs.view', t);
    const filter: any = { storeId };
    if (q?.supplierId) filter.supplierId = String(q.supplierId);
    if (q?.purchaseOrderId) filter.purchaseOrderId = String(q.purchaseOrderId);
    const rows: any[] = await this.r.purchaseReceiptModel.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    return { success: true, data: { ...(await this.cur(storeId)), receipts: rows.map((x) => this.receiptView(x, true)) } };
  }

  // ── supplier returns ──────────────────────────────────────────────────────────
  /** Stock leaves through the existing return service (same rules, same transaction), and the supplier's CREDIT is written to the payables ledger inside that transaction. */
  async createReturn(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'supply.return', t);
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    if (!Array.isArray(body?.items) || body.items.length === 0) throw err(400, 'ITEMS_REQUIRED', 'Nothing to return');
    let receipt: any = null;
    if (body.receiptId) {
      if (!Types.ObjectId.isValid(String(body.receiptId))) throw err(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
      receipt = await this.r.purchaseReceiptModel.findOne({ _id: body.receiptId, storeId }).lean();
      if (!receipt) throw err(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
      const prior: any[] = await this.r.supplierReturnModel.find({ storeId, receiptId: String(receipt._id) }).select('items').lean();
      const back = new Map<string, number>();
      for (const r of prior) for (const i of r.items ?? []) back.set(i.variantId, (back.get(i.variantId) ?? 0) + i.quantity);
      for (const it of body.items) {
        const line = (receipt.lines ?? []).find((l: any) => l.variantId === String(it.variantId));
        if (!line) throw err(400, 'NOT_ON_RECEIPT', 'A returned product was not on that receipt');
        const left = line.qtyGood + (line.qtyDamaged ?? 0) - (back.get(line.variantId) ?? 0);
        if (qtyOf(it.quantity, 'quantity', 1) > left) throw err(409, 'EXCEEDS_RECEIPT', `${line.name}: only ${Math.max(0, left)} unit(s) of this receipt can still be returned.`);
        if (it.lotId) { const lot: any = await this.r.stockLotModel.findOne({ _id: it.lotId, storeId }).select('receiptId').lean(); if (!lot || lot.receiptId !== String(receipt._id)) throw err(400, 'LOT_NOT_ON_RECEIPT', 'That lot did not come in on this receipt'); }
      }
    }
    const dto: any = {
      supplierId: receipt?.supplierId ?? body.supplierId, purchaseOrderId: receipt?.purchaseOrderId ?? body.purchaseOrderId, receiptId: receipt ? String(receipt._id) : undefined, locationId: receipt?.locationId ?? body.locationId,
      reason: body.reason ?? 'other', note: str(body.note, 500) ?? undefined, requestId: str(body.requestId, 100) ?? undefined,
      items: body.items.map((it: any) => {
        const line = receipt?.lines?.find((l: any) => l.variantId === String(it.variantId));
        const unitMinor = it.unitCostMinor !== undefined ? minorOf(it.unitCostMinor, 'unitCostMinor') : line?.unitCostMinor;
        return { variantId: String(it.variantId), quantity: qtyOf(it.quantity, 'quantity', 1), lotId: it.lotId, fromDamaged: !!it.fromDamaged, purchaseOrderItemId: line?.poItemId ?? it.purchaseOrderItemId, ...(unitMinor !== undefined ? { unitCost: fromMinor(unitMinor, exp) } : {}) };
      }),
    };
    const out: any = await this.returns.create(storeId, req.user.userId, dto, a.employeeId ?? req.user.userId, undefined, {
      inTx: async (tx, doc) => {
        const creditMinor = doc.totalCreditMinor ?? toMinor(doc.totalCredit, exp);
        if (doc.supplierId && creditMinor > 0) {
          await this.r.supplierLedgerEntryModel.create([{
            storeId, supplierId: doc.supplierId, type: 'credit', amountMinor: -creditMinor, currency, currencyExponent: exp, refType: 'supplier_return', refId: String(doc._id), refNumber: doc.returnNumber, purchaseOrderId: doc.purchaseOrderId ?? null,
            employeeId: a.employeeId, deviceId: this.deviceOf(req), dedupeKey: `return:${String(doc._id)}`,
          }], { session: tx });
        }
      },
    });
    const d = out.data;
    await this.audit(storeId, a.employeeId, 'supplier_return', String(d._id), { returnNumber: d.returnNumber, creditMinor: d.totalCreditMinor });
    return { success: true, data: { ...(await this.cur(storeId)), duplicate: !!out.duplicate, return: { id: String(d._id), returnNumber: d.returnNumber, supplierId: d.supplierId ?? null, supplierName: d.supplierName, receiptId: d.receiptId ?? null, purchaseOrderId: d.purchaseOrderId ?? null, reason: d.reason, creditMinor: d.totalCreditMinor ?? 0, createdAt: d.createdAt ?? null, items: (d.items ?? []).map((i: any) => ({ variantId: i.variantId, name: i.name, quantity: i.quantity, lotId: i.lotId ?? null, unitCostMinor: i.unitCostMinor ?? toMinor(i.unitCost, exp) })) } } };
  }
  async returnsList(req: Req, storeId: string, q: any, t: Tokens) {
    await this.gate(req, storeId, 'supply.costs.view', t);
    const filter: any = { storeId }; if (q?.supplierId) filter.supplierId = String(q.supplierId);
    const rows: any[] = await this.r.supplierReturnModel.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    const c = await this.cur(storeId);
    return { success: true, data: { ...c, returns: rows.map((d) => ({ id: String(d._id), returnNumber: d.returnNumber, supplierId: d.supplierId ?? null, supplierName: d.supplierName, receiptId: d.receiptId ?? null, reason: d.reason, creditMinor: d.totalCreditMinor ?? toMinor(d.totalCredit ?? 0, c.currencyExponent), createdAt: d.createdAt ?? null })) } };
  }

  // ── payables + payments ───────────────────────────────────────────────────────
  async payables(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'supply.costs.view', t);
    const rows: any[] = await this.r.supplierLedgerEntryModel.find({ storeId }).select('supplierId type amountMinor createdAt supplierInvoiceDate').lean();
    const by = new Map<string, any[]>();
    for (const e of rows) { const a = by.get(e.supplierId) ?? []; a.push({ type: e.type, amountMinor: e.amountMinor, at: e.type === 'bill' && e.supplierInvoiceDate ? e.supplierInvoiceDate : e.createdAt }); by.set(e.supplierId, a); }
    const sups: any[] = await this.r.supplierModel.find({ storeId, _id: { $in: [...by.keys()].filter((k) => Types.ObjectId.isValid(k)) } }).select('name').lean();
    const name = new Map(sups.map((s) => [String(s._id), s.name]));
    const now = new Date();
    const list = [...by.entries()].map(([supplierId, es]) => ({ supplierId, supplierName: name.get(supplierId) ?? 'Supplier', ...computeAging(es, now) })).filter((x) => x.balanceMinor !== 0).sort((x, y) => y.balanceMinor - x.balanceMinor);
    const totals = list.reduce((s, x) => ({ balanceMinor: s.balanceMinor + x.balanceMinor, currentMinor: s.currentMinor + x.currentMinor, d30Minor: s.d30Minor + x.d30Minor, d60Minor: s.d60Minor + x.d60Minor, d90Minor: s.d90Minor + x.d90Minor }), { balanceMinor: 0, currentMinor: 0, d30Minor: 0, d60Minor: 0, d90Minor: 0 });
    return { success: true, data: { ...(await this.cur(storeId)), totals, suppliers: list } };
  }
  async ledger(req: Req, storeId: string, supplierId: string, t: Tokens) {
    await this.gate(req, storeId, 'supply.costs.view', t);
    const s = await this.loadSupplier(storeId, supplierId);
    const rows: any[] = await this.r.supplierLedgerEntryModel.find({ storeId, supplierId }).sort({ createdAt: 1, _id: 1 }).lean();
    let run = 0;
    const entries = rows.map((e) => { run += e.amountMinor; return { id: String(e._id), type: e.type, amountMinor: e.amountMinor, balanceAfterMinor: run, refType: e.refType, refId: e.refId, refNumber: e.refNumber, method: e.method, reference: e.reference, supplierInvoiceNumber: e.supplierInvoiceNumber, supplierInvoiceDate: e.supplierInvoiceDate, note: e.note, createdAt: e.createdAt }; }).reverse();
    return { success: true, data: { ...(await this.cur(storeId)), supplier: this.supplierView(s), aging: await this.agingOf(storeId, supplierId), entries } };
  }
  /**
   * Pay a supplier. cash = from the open shift's drawer (the shift's expected cash goes down, in the SAME transaction; needs `sessionId`); bank / other are recorded only.
   * The payment cannot exceed what is owed. Above the manager's limit the OWNER approves (matrix). Idempotent per `requestId`.
   */
  async pay(req: Req, storeId: string, supplierId: string, body: any, t: Tokens) {
    const amountMinor = minorOf(body?.amountMinor, 'amountMinor', { allowZero: false });
    const a = await this.gate(req, storeId, 'supply.payment', t, { amountMinor });
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const method = String(body?.method ?? '');
    if (!(SUPPLIER_PAYMENT_METHODS as readonly string[]).includes(method)) throw err(400, 'INVALID_METHOD', 'Choose how it was paid: cash, bank or other');
    const requestId = str(body?.requestId, 100);
    if (!requestId) throw err(400, 'REQUEST_ID_REQUIRED', 'A payment needs a requestId so a retry cannot pay twice');
    const sessionId = str(body?.sessionId, 40);
    if (method === 'cash' && !sessionId) throw err(409, 'NO_OPEN_SHIFT', 'Paying cash from the drawer needs an open shift.');
    const sup = await this.loadSupplier(storeId, supplierId);
    const dedupeKey = `payment:${requestId}`;
    const existing: any = await this.r.supplierLedgerEntryModel.findOne({ storeId, dedupeKey }).lean();
    const view = async (e: any, duplicate: boolean) => ({ success: true, data: { ...(await this.cur(storeId)), duplicate, payment: { id: String(e._id), supplierId, amountMinor: -e.amountMinor, method: e.method, reference: e.reference, sessionId: e.sessionId, createdAt: e.createdAt }, balanceMinor: await this.balanceOf(storeId, supplierId) } });
    if (existing) return view(existing, true);
    const by = a.approvedBy?.employeeId ?? null;
    let entry: any;
    try {
      entry = await this.atomic(async (tx) => {
        await this.r.supplierModel.updateOne({ _id: supplierId, storeId }, { $inc: { ledgerRev: 1 } }, { session: tx }); // serialize payments of one supplier
        const balance = await this.balanceOf(storeId, supplierId, tx);
        if (amountMinor > balance) throw err(409, 'EXCEEDS_BALANCE', 'That is more than is owed to this supplier.', { balanceMinor: balance });
        const [e] = await this.r.supplierLedgerEntryModel.create([{
          storeId, supplierId, type: 'payment', amountMinor: -amountMinor, currency, currencyExponent: exp, refType: 'payment', method, reference: str(body?.reference, 120), sessionId: method === 'cash' ? sessionId : null, note: str(body?.note, 300),
          employeeId: a.employeeId, approvedBy: by, deviceId: this.deviceOf(req), dedupeKey,
        }], { session: tx });
        if (method === 'cash') {
          await recordCashOut(this.r.registerSessionModel, tx, { storeId, sessionId: sessionId!, amountMinor, exp, reason: `Supplier payment — ${sup.name}${str(body?.reference, 120) ? ` (${str(body?.reference, 120)})` : ''}`, employeeId: a.employeeId ?? 'owner', category: 'supplier_payment', refType: 'supplier_payment', refId: String(e._id) });
        }
        await this.audit(storeId, a.employeeId, 'supplier_payment', String(e._id), { supplierId, supplierName: sup.name, amountMinor, method, sessionId, approvedBy: by }, tx);
        return e;
      });
    } catch (e: any) {
      if (e?.code === 11000) { const dup: any = await this.r.supplierLedgerEntryModel.findOne({ storeId, dedupeKey }).lean(); if (dup) return view(dup, true); }
      throw e;
    }
    return view(entry.toObject(), false);
  }
}
