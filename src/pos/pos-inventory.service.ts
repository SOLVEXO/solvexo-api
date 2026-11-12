/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { InventoryService } from '../inventory/inventory.service';
import { StockCountsService } from '../stock-counts/stock-counts.service';
import { isoExponent, toMinor } from '@/common/money-minor.util';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { APPROVAL_LIMITS, PosAction } from './pos-permissions.config';
import { STOCK_MOVEMENT_TYPES } from '../inventory/schemas/stock-movement.schema';
import { previewLotsFefo } from '../common/lot-allocation.util';
import { expiredUnits } from '../common/stock-availability.util';

export const POS_ADJUST_REASONS = ['restocked', 'damaged', 'correction', 'other'] as const;
type Req = any;
interface Tokens { employee?: string; approver?: string }

/**
 * G3.1 — the till's view of inventory: a facade over the existing inventory / stock-count services (the dashboard and the till see the SAME data), behind the permission
 * matrix (`PosAuthorizer`: device + PIN session, role, approval limits), audited, idempotent where it writes. Cost figures are manager / owner only. Nothing here owns stock logic.
 */
@Injectable()
export class PosInventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly pos: PosService,
    private readonly auth: PosAuthorizer,
    private readonly inventory: InventoryService,
    private readonly counts: StockCountsService,
  ) {}
  private get r() { return this.db.repositories; }

  private async gate(req: Req, storeId: string, action: PosAction, t: Tokens, ctx?: Parameters<PosAuthorizer['authorize']>[1]['ctx']) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    return this.auth.authorize(req, { storeId, action, ctx, employeeToken: t.employee, approverToken: t.approver });
  }
  private async exp(storeId: string): Promise<number> {
    return (await this.cur(storeId)).currencyExponent;
  }
  /** Contract: EVERY response that carries money states its currency code and exponent (the app never falls back to a configured one). */
  private async cur(storeId: string): Promise<{ currency: string; currencyExponent: number }> {
    const s: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = String(s?.baseCurrency || 'USD').toUpperCase();
    return { currency, currencyExponent: isoExponent(currency) };
  }
  private audit(storeId: string, employeeId: string | null, action: string, targetId: string | null, metadata: object) {
    return this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'inventory', metadata }]);
  }
  private seesCost = (role: string) => role === 'manager' || role === 'owner';

  /** A variant of THIS store: by id, then its product must be the store's (variants that predate `storeId` are matched through the product, like the catalog edit). */
  private async loadVariant(storeId: string, variantId: string, select = ''): Promise<any> {
    const v: any = await this.r.productVariantModel.findOne({ _id: variantId, isDelete: false }).select(select).lean();
    if (!v) throw new NotFoundException('Variant not found');
    if (v.storeId && String(v.storeId) !== storeId) throw new NotFoundException('Variant not found');
    const p: any = await this.r.productModel.findOne({ _id: v.productId, storeId, isDelete: false }).select('_id').lean();
    if (!p) throw new NotFoundException('Variant not found');
    return v;
  }

  private async productNames(ids: string[]): Promise<Map<string, any>> {
    const rows: any[] = ids.length ? await this.r.productModel.find({ _id: { $in: ids } }).select('name images type').lean() : [];
    return new Map(rows.map((p) => [String(p._id), p]));
  }
  private row(v: any, p: any, cost: boolean, exp: number) {
    const stock = Math.max(0, v.stock ?? 0);
    const reorder = v.reorderPoint ?? 0;
    const costMinor = v.costPriceMinor ?? (v.costPrice != null ? toMinor(v.costPrice, exp) : null);
    return {
      variantId: String(v._id), productId: v.productId, productName: p?.name ?? '', image: p?.images?.[0] ?? null, sku: v.sku ?? null, barcode: v.barcode ?? null, options: v.options ?? [],
      stock, committed: v.committedStock ?? 0, damaged: v.damagedStock ?? 0, unlimited: !!v.unlimitedStock, trackLots: !!v.trackLots, reorderPoint: reorder,
      expiredUnits: v.trackLots ? expiredUnits(v) : 0, nextExpiryAt: v.trackLots ? (v.expiryBuckets ?? []).find((b: any) => b?.at && new Date(b.at).getTime() > Date.now())?.at ?? null : null,
      out: !v.unlimitedStock && stock <= 0, low: !v.unlimitedStock && reorder > 0 && stock <= reorder,
      ...(cost ? { costMinor, valueMinor: costMinor != null ? costMinor * stock : null } : {}),
    };
  }

  async overview(req: Req, storeId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.view', t);
    const variants: any[] = await this.r.productVariantModel.find({ storeId, isDelete: false }).select('stock reorderPoint unlimitedStock costPrice costPriceMinor trackLots').lean();
    const exp = await this.exp(storeId);
    let skus = 0, low = 0, out = 0, value = 0, noCost = 0;
    for (const v of variants) {
      if (v.unlimitedStock) continue;
      skus++;
      const stock = Math.max(0, v.stock ?? 0);
      if (stock <= 0) out++; else if ((v.reorderPoint ?? 0) > 0 && stock <= v.reorderPoint) low++;
      const c = v.costPriceMinor ?? (v.costPrice != null ? toMinor(v.costPrice, exp) : null);
      if (c == null) noCost++; else value += c * stock;
    }
    const now = new Date(); const in7 = new Date(now.getTime() + 7 * 86400_000); const in30 = new Date(now.getTime() + 30 * 86400_000);
    const lots = this.r.stockLotModel;
    const [expired, exp7, exp30] = await Promise.all([
      lots.countDocuments({ storeId, status: { $ne: 'depleted' }, quantityRemaining: { $gt: 0 }, expiryDate: { $lt: now } }),
      lots.countDocuments({ storeId, status: 'active', quantityRemaining: { $gt: 0 }, expiryDate: { $gte: now, $lte: in7 } }),
      lots.countDocuments({ storeId, status: 'active', quantityRemaining: { $gt: 0 }, expiryDate: { $gte: now, $lte: in30 } }),
    ]);
    const openCount: any = await this.r.stockCountModel.findOne({ storeId, status: 'open' }).select('_id createdAt locationId').lean();
    return { success: true, data: { role: a.role, skuCount: skus, lowStockCount: low, outOfStockCount: out, expiredLots: expired, expiringIn7Days: exp7, expiringIn30Days: exp30,
      openStockCount: openCount ? { id: String(openCount._id), startedAt: openCount.createdAt } : null,
      ...(await this.cur(storeId)), ...(this.seesCost(a.role) ? { stockValueMinor: value, variantsWithoutCost: noCost } : {}) } };
  }

  async stock(req: Req, storeId: string, q: { search?: string; filter?: string; page?: string; limit?: string; locationId?: string }, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.view', t);
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const filter: any = { storeId, isDelete: false };
    const term = (q.search ?? '').trim().slice(0, 60);
    if (term) {
      const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const prods: any[] = await this.r.productModel.find({ storeId, isDelete: false, name: rx }).select('_id').limit(200).lean();
      filter.$or = [{ sku: rx }, { barcode: term }, { productId: { $in: prods.map((p) => String(p._id)) } }];
    }
    if (q.filter === 'out') { filter.unlimitedStock = { $ne: true }; filter.stock = { $lte: 0 }; }
    if (q.filter === 'expiring') { filter.trackLots = true; filter.$or = [...(filter.$or ? [] : []), { expiredStock: { $gt: 0 } }, { 'expiryBuckets.0.at': { $lte: new Date(Date.now() + 30 * 86400_000) } }]; }
    if (q.filter === 'low') { filter.unlimitedStock = { $ne: true }; filter.reorderPoint = { $gt: 0 }; filter.$expr = { $lte: ['$stock', '$reorderPoint'] }; }
    // G5.1: one location — the variants stocked there (bins summed), each row with that location's quantity; "out" = none left AT that location
    let atLocation: Map<string, number> | null = null;
    const locationId = typeof q.locationId === 'string' && /^[a-f0-9]{24}$/i.test(q.locationId) ? q.locationId : null;
    if (q.locationId && !locationId) throw new BadRequestException({ statusCode: 400, code: 'LOCATION_INVALID', message: 'Unknown location' });
    if (locationId) {
      const loc: any = await this.r.storeLocationModel?.findOne({ _id: locationId, storeId }).select('_id').lean();
      if (this.r.storeLocationModel && !loc) throw new BadRequestException({ statusCode: 400, code: 'LOCATION_INVALID', message: 'Unknown location' });
      const sums: any[] = await this.r.variantLocationStockModel.aggregate([{ $match: { storeId, locationId } }, { $group: { _id: '$variantId', stock: { $sum: '$stock' } } }]);
      atLocation = new Map(sums.map((x) => [String(x._id), Number(x.stock) || 0]));
      const ids = [...atLocation.entries()].filter(([, n]) => (q.filter === 'out' ? n <= 0 : true)).map(([id]) => id);
      if (q.filter === 'out') { delete filter.stock; }
      filter._id = { $in: ids.filter((id) => /^[a-f0-9]{24}$/i.test(id)) };
    }
    const [rows, total]: [any[], number] = await Promise.all([
      this.r.productVariantModel.find(filter).sort({ updatedAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.productVariantModel.countDocuments(filter),
    ]);
    const names = await this.productNames([...new Set(rows.map((v) => String(v.productId)))]);
    const exp = await this.exp(storeId);
    return { success: true, data: { ...(await this.cur(storeId)), ...(locationId ? { locationId } : {}), items: rows.map((v) => ({ ...this.row(v, names.get(String(v.productId)), this.seesCost(a.role), exp), ...(atLocation ? { locationStock: atLocation.get(String(v._id)) ?? 0 } : {}) })), total, page, hasMore: page * limit < total } };
  }

  /** G5.1: the store's locations for the till's stock-list filter (the owner-session locations route refuses device tokens): id, name, status only. */
  async locations(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'inventory.view', t);
    const rows: any[] = await this.r.storeLocationModel.find({ storeId, isDelete: { $ne: true } }).select('name status').sort({ name: 1 }).lean();
    return { success: true, data: { locations: rows.map((l) => ({ id: String(l._id), name: l.name, status: l.status ?? 'active' })) } };
  }

  async lookup(req: Req, storeId: string, code: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.view', t);
    const term = (code ?? '').trim();
    if (!term || term.length > 100) throw new BadRequestException('Scan or type a barcode / SKU');
    const rows: any[] = await this.r.productVariantModel.find({ storeId, isDelete: false, $or: [{ barcode: term }, { sku: term }] }).limit(5).lean();
    const names = await this.productNames([...new Set(rows.map((v) => String(v.productId)))]);
    const exp = await this.exp(storeId);
    const c = await this.cur(storeId);
    return { success: true, data: rows.map((v) => ({ ...this.row(v, names.get(String(v.productId)), this.seesCost(a.role), exp), ...c })) };
  }

  async detail(req: Req, storeId: string, variantId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.view', t);
    const v: any = await this.loadVariant(storeId, variantId);
    const names = await this.productNames([String(v.productId)]);
    const exp = await this.exp(storeId);
    const [locRows, locs, lots, moves, first]: any[] = await Promise.all([
      this.r.variantLocationStockModel.find({ variantId }).lean(),
      this.r.storeLocationModel.find({ storeId, isDelete: false }).select('name isDefault').lean(),
      this.r.stockLotModel.find({ variantId, status: { $ne: 'depleted' }, quantityRemaining: { $gt: 0 } }).sort({ expiryDate: 1 }).limit(20).lean(),
      this.seesCost(a.role) || true ? this.r.stockMovementModel.find({ storeId, variantId }).sort({ createdAt: -1 }).limit(10).lean() : [],
      this.r.stockMovementModel.findOne({ storeId, variantId }).sort({ createdAt: 1 }).select('createdAt').lean(),
    ]);
    const locName = new Map(locs.map((l: any) => [String(l._id), l.name]));
    const cost = this.seesCost(a.role);
    return { success: true, data: {
      ...this.row(v, names.get(String(v.productId)), cost, exp),
      locations: locRows.map((l: any) => ({ locationId: l.locationId, name: locName.get(String(l.locationId)) ?? 'Location', stock: l.stock })),
      lots: lots.map((l: any) => ({ lotId: String(l._id), lotNumber: l.lotNumber, expiryDate: l.expiryDate ?? null, remaining: l.quantityRemaining, ...(cost ? { costMinor: l.costPriceMinor ?? toMinor(l.costPrice, exp) } : {}) })),
      recentMovements: moves.map((m: any) => this.moveRow(m, cost)),
      ledgerStartsAt: first?.createdAt ?? null, // before this moment the history is not in the ledger (never guessed)
      ...(await this.cur(storeId)),
    } };
  }

  private moveRow(m: any, cost: boolean) {
    return { id: String(m._id), at: m.createdAt, type: m.type, qtyDelta: m.qtyDelta, damagedDelta: m.damagedDelta ?? 0, reason: m.reason ?? null, note: m.note ?? null, refType: m.refType ?? null, refId: m.refId ?? null, employeeId: m.employeeId ?? null,
      productName: m.productName ?? null, sku: m.sku ?? null, variantId: m.variantId, ...(cost ? { unitCostMinor: m.unitCostMinor ?? null } : {}) };
  }

  async movements(req: Req, storeId: string, q: { variantId?: string; type?: string; from?: string; to?: string; page?: string; limit?: string }, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.history.view', t);
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const f: any = { storeId };
    if (q.variantId) f.variantId = q.variantId;
    if (q.type && (STOCK_MOVEMENT_TYPES as readonly string[]).includes(q.type)) f.type = q.type;
    if (q.from || q.to) { f.createdAt = {}; if (q.from) f.createdAt.$gte = new Date(q.from); if (q.to) f.createdAt.$lte = new Date(q.to); }
    const [rows, total]: [any[], number] = await Promise.all([
      this.r.stockMovementModel.find(f).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.stockMovementModel.countDocuments(f),
    ]);
    return { success: true, data: { ...(await this.cur(storeId)), items: rows.map((m) => this.moveRow(m, this.seesCost(a.role))), total, page, hasMore: page * limit < total } };
  }

  /** Expired / expiring lots of the store (counts) — Home and the overview. */
  async expiringSummary(storeId: string) {
    const now = new Date(); const lots = this.r.stockLotModel;
    const base = { storeId, status: 'active', quantityRemaining: { $gt: 0 }, expiryDate: { $type: 'date' } };
    const [expired, in7, in30] = await Promise.all([
      lots.countDocuments({ ...base, expiryDate: { $lt: now } }),
      lots.countDocuments({ ...base, expiryDate: { $gte: now, $lte: new Date(now.getTime() + 7 * 86400_000) } }),
      lots.countDocuments({ ...base, expiryDate: { $gte: now, $lte: new Date(now.getTime() + 30 * 86400_000) } }),
    ]);
    return { expiredLots: expired, expiringIn7Days: in7, expiringIn30Days: in30 };
  }

  /**
   * FEFO suggestion for [qty] units of a lot-tracked variant (read-only): which lots a sale or a transfer would take, soonest expiry first; expired lots are NOT offered
   * (selling them is the manager override of the sale). The till shows it at the line; the SERVER re-allocates when the sale is recorded (and for an offline sale, at sync).
   */
  async lotsSuggest(req: Req, storeId: string, variantId: string, qty: number, t: Tokens) {
    await this.gate(req, storeId, 'inventory.view', t);
    const v: any = await this.loadVariant(storeId, variantId);
    const q = Math.max(1, Math.min(100_000, Math.trunc(Number(qty) || 1)));
    if (!v.trackLots) return { success: true, data: { variantId, trackLots: false, qty: q, allocations: [], shortBy: 0, expiredUnits: 0, serverTime: new Date() } };
    const { allocations, shortBy } = await previewLotsFefo(this.r as any, variantId, q);
    const now = Date.now();
    return { success: true, data: { variantId, trackLots: true, qty: q, serverTime: new Date(), shortBy, expiredUnits: expiredUnits(v),
      allocations: allocations.map((a) => ({ lotId: a.lotId, lotNumber: a.lotNumber, take: a.qty, expiryDate: a.expiryDate, daysLeft: a.expiryDate ? Math.ceil((new Date(a.expiryDate).getTime() - now) / 86400_000) : null })) } };
  }

  async lowStock(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'inventory.view', t);
    return this.stock(req, storeId, { filter: 'low', limit: '100' }, t);
  }

  async adjust(req: Req, storeId: string, variantId: string, dto: { delta: number; reason: string; note?: string; locationId?: string }, t: Tokens) {
    const delta = Number(dto?.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) throw new BadRequestException({ statusCode: 400, code: 'DELTA_INVALID', message: 'Say how many units to add or remove' });
    if (!(POS_ADJUST_REASONS as readonly string[]).includes(dto?.reason)) throw new BadRequestException({ statusCode: 400, code: 'REASON_INVALID', message: 'Pick a reason', allowed: POS_ADJUST_REASONS });
    const note = (dto.note ?? '').toString().trim().slice(0, 300) || undefined;
    if (dto.reason === 'other' && !note) throw new BadRequestException({ statusCode: 400, code: 'NOTE_REQUIRED', message: 'Say why' });
    const v: any = await this.loadVariant(storeId, variantId, 'costPrice costPriceMinor productId sku unlimitedStock storeId');
    if (v.unlimitedStock) throw new BadRequestException({ statusCode: 400, code: 'UNLIMITED_STOCK', message: 'This item has unlimited stock' });
    const exp = await this.exp(storeId);
    const costMinor = v.costPriceMinor ?? (v.costPrice != null ? toMinor(v.costPrice, exp) : 0);
    const a = await this.gate(req, storeId, 'inventory.adjust', t, { qty: Math.abs(delta), valueMinor: Math.abs(delta) * costMinor });
    const res: any = await this.inventory.adjustStock(req.user.userId, storeId, variantId, delta, dto.reason as any, note, dto.locationId);
    await this.audit(storeId, a.employeeId, 'stock_adjusted', variantId, { delta, reason: dto.reason, note: note ?? null, locationId: dto.locationId ?? null, role: a.role, approvedBy: a.approvedBy?.employeeId ?? null, valueMinor: Math.abs(delta) * costMinor });
    return res;
  }

  // ── stock counts ───────────────────────────────────────────────────────────
  async countStart(req: Req, storeId: string, locationId: string | undefined, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.count.start', t);
    const data = await this.counts.start(storeId, req.user.userId, locationId, { userId: a.employeeId ?? req.user.userId, role: a.role });
    await this.audit(storeId, a.employeeId, 'stock_count_started', String((data as any)._id), { locationId: locationId ?? null });
    return { success: true, data };
  }
  async countList(req: Req, storeId: string, t: Tokens) { await this.gate(req, storeId, 'inventory.view', t); return { success: true, data: await this.counts.list(storeId, req.user.userId) }; }
  async countGet(req: Req, storeId: string, id: string, t: Tokens) { await this.gate(req, storeId, 'inventory.view', t); return { success: true, data: await this.counts.getById(storeId, req.user.userId, id) }; }

  /** Find the count line for a scanned barcode / SKU (count by scan: the till shows it, the person confirms the quantity). */
  async countFind(req: Req, storeId: string, id: string, code: string, t: Tokens) {
    await this.gate(req, storeId, 'inventory.count.enter', t);
    const count: any = await this.counts.getById(storeId, req.user.userId, id);
    const term = (code ?? '').trim();
    if (!term) throw new BadRequestException('Scan or type a barcode / SKU');
    const hit = (count.items as any[]).find((i) => i.sku === term || i.barcode === term);
    let item = hit;
    if (!item) {
      const v: any = await this.r.productVariantModel.findOne({ storeId, isDelete: false, $or: [{ barcode: term }, { sku: term }] }).select('_id').lean();
      item = v ? (count.items as any[]).find((i) => String(i.variantId) === String(v._id)) : null;
    }
    return { success: true, data: item ? { found: true, item } : { found: false } };
  }
  async countEnter(req: Req, storeId: string, id: string, itemId: string, countedQty: number, t: Tokens) {
    await this.gate(req, storeId, 'inventory.count.enter', t);
    if (!Number.isInteger(countedQty) || countedQty < 0 || countedQty > 1_000_000) throw new BadRequestException({ statusCode: 400, code: 'QTY_INVALID', message: 'Enter a whole number of units, zero or more' });
    return { success: true, data: await this.counts.submitCount(storeId, req.user.userId, id, itemId, countedQty) };
  }
  async countFinish(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.count.finish', t);
    const data = await this.counts.finish(storeId, req.user.userId, id, { userId: a.employeeId ?? req.user.userId, role: a.role });
    await this.audit(storeId, a.employeeId, 'stock_count_finished', id, { role: a.role, result: (data as any)?.summary ?? null });
    return { success: true, data };
  }
  async countCancel(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.count.start', t);
    const data = await this.counts.cancel(storeId, req.user.userId, id);
    await this.audit(storeId, a.employeeId, 'stock_count_cancelled', id, {});
    return { success: true, data };
  }

  // ── approval limits (D6) ───────────────────────────────────────────────────
  async limits(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'settings.approvalLimits.view', t);
    const resolved = await this.auth.limitsFor(storeId);
    const exp = await this.exp(storeId);
    return { success: true, data: { ...(await this.cur(storeId)), limits: Object.entries(APPROVAL_LIMITS).map(([key, d]: [string, any]) => ({ key, label: d.label, kind: d.kind, value: (resolved as any)[key], defaultValue: d.kind === 'minor' ? Math.round(d.default * 10 ** exp) : d.default })) } };
  }
  async setLimits(req: Req, storeId: string, body: Record<string, number>, t: Tokens) {
    const a = await this.gate(req, storeId, 'settings.approvalLimits.edit', t);
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!(k in APPROVAL_LIMITS)) throw new BadRequestException({ statusCode: 400, code: 'UNKNOWN_LIMIT', message: `Unknown limit ${k}` });
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new BadRequestException({ statusCode: 400, code: 'LIMIT_INVALID', message: `${k} must be a whole number, zero or more` });
      clean[k] = v;
    }
    const before: any = await this.r.posSettingsModel.findOne({ storeId }).select('approvalLimits').lean();
    await this.r.posSettingsModel.updateOne({ storeId }, { $set: Object.fromEntries(Object.entries(clean).map(([k, v]) => [`approvalLimits.${k}`, v])) }, { upsert: true });
    await this.audit(storeId, a.employeeId, 'approval_limits_changed', storeId, { before: before?.approvalLimits ?? {}, changes: clean });
    return this.limits(req, storeId, t);
  }

  // ── G4.6: transfers, expiry buckets + write-off ───────────────────────────────
  /** The dashboard's transfers (ship → in transit → received / cancelled) behind the matrix. Errors keep the inventory service's wording. */
  async transfers(req: Req, storeId: string, q: any, t: Tokens) {
    await this.gate(req, storeId, 'inventory.view', t);
    return this.inventory.listTransfers(req.user.userId, storeId, { status: q?.status ?? 'all' });
  }
  async transferShip(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.transfer.create', t);
    const qty = Number(body?.quantity);
    const out: any = await this.inventory.shipTransfer(req.user.userId, storeId, String(body?.variantId ?? ''), String(body?.fromLocationId ?? ''), String(body?.toLocationId ?? ''), qty, typeof body?.note === 'string' ? body.note.slice(0, 300) : undefined);
    await this.audit(storeId, a.employeeId, 'transfer_shipped', String(out?.data?._id ?? ''), { variantId: body?.variantId, quantity: qty, from: body?.fromLocationId, to: body?.toLocationId });
    return out;
  }
  async transferReceive(req: Req, storeId: string, transferId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.transfer.receive', t);
    const qty = Number(body?.receivedQty);
    const out: any = await this.inventory.receiveTransfer(req.user.userId, storeId, transferId, qty, typeof body?.binId === 'string' ? body.binId : undefined);
    await this.audit(storeId, a.employeeId, 'transfer_received', transferId, { receivedQty: qty });
    return out;
  }
  async transferCancel(req: Req, storeId: string, transferId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.transfer.create', t);
    const out: any = await this.inventory.cancelTransfer(req.user.userId, storeId, transferId);
    await this.audit(storeId, a.employeeId, 'transfer_cancelled', transferId, {});
    return out;
  }
  /** Lots by how soon they expire: expired / within 7 days / within 30 days (store time zone), with value at cost for managers. */
  async expiry(req: Req, storeId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.view', t);
    const c = await this.cur(storeId);
    const now = new Date(); const in7 = new Date(now.getTime() + 7 * 86_400_000); const in30 = new Date(now.getTime() + 30 * 86_400_000);
    const lots: any[] = await this.r.stockLotModel.find({ storeId, status: 'active', quantityRemaining: { $gt: 0 }, expiryDate: { $ne: null, $lt: in30 } }).sort({ expiryDate: 1 }).limit(500).lean();
    const vIds = [...new Set(lots.map((l) => l.variantId))];
    const vs: any[] = vIds.length ? await this.r.productVariantModel.find({ _id: { $in: vIds } }).select('sku productId options').lean() : [];
    const vm = new Map(vs.map((v) => [String(v._id), v]));
    const names = await this.productNames([...new Set(vs.map((v) => String(v.productId)))]);
    const cost = this.seesCost(a.role);
    const row = (l: any) => { const v = vm.get(String(l.variantId)); return { lotId: String(l._id), lotNumber: l.lotNumber, variantId: l.variantId, sku: v?.sku ?? null, productName: names.get(String(v?.productId))?.name ?? '', expiryDate: l.expiryDate, remaining: l.quantityRemaining, daysLeft: Math.ceil((new Date(l.expiryDate).getTime() - now.getTime()) / 86_400_000), ...(cost ? { valueMinor: (l.costPriceMinor ?? 0) * l.quantityRemaining } : {}) }; };
    const expired = lots.filter((l) => new Date(l.expiryDate) <= now).map(row);
    const within7 = lots.filter((l) => new Date(l.expiryDate) > now && new Date(l.expiryDate) <= in7).map(row);
    const within30 = lots.filter((l) => new Date(l.expiryDate) > in7).map(row);
    return { success: true, data: { ...c, expired, within7, within30 } };
  }
  /** Write off (part of) a lot: expired or damaged. Managers (matrix `inventory.writeoff`); goes through the inventory service (stock, lot, location, adjustment → ledger). */
  async writeOffLot(req: Req, storeId: string, lotId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.writeoff', t);
    const reason = body?.reason === 'damaged' ? 'damaged' : 'expired';
    const quantity = body?.quantity === undefined || body?.quantity === null ? undefined : Number(body.quantity);
    const out: any = await this.inventory.writeOffLot(req.user.userId, storeId, lotId, { quantity, reason, note: typeof body?.note === 'string' ? body.note.slice(0, 300) : undefined });
    await this.audit(storeId, a.employeeId, 'lot_written_off', lotId, { quantity: out?.data?.written, reason });
    const c = await this.cur(storeId);
    return { success: true, data: { ...c, lotId, lotNumber: out?.data?.lotNumber, written: out?.data?.written, remaining: out?.data?.remaining, newStock: out?.data?.newStock } };
  }
}
