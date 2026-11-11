/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { fromMinor, isoExponent, isSafeMinor } from '@/common/money-minor.util';
import { ProductsService } from '../products/products.service';
import { ProductVariantsService } from '../product-variants/product-variants.service';
import { CategoriesService } from '../categories/categories.service';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAction } from './pos-permissions.config';
import { localDay, localKey } from './pos-day.util';

type Req = any;
interface Tokens { employee?: string }
const err = (status: 400 | 404 | 409, code: string, message: string, extra: object = {}) => {
  const body = { statusCode: status, code, message, ...extra };
  return status === 404 ? new NotFoundException(body) : status === 409 ? new ConflictException(body) : new BadRequestException(body);
};
const str = (v: any, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const minor = (v: any, field: string, allowNegative = false): number => {
  if (!isSafeMinor(v) || (!allowNegative && v < 0)) throw err(400, 'INVALID_AMOUNT', `${field} must be a whole number of minor units${allowNegative ? '' : ' (0 or more)'}`);
  return v;
};
const oid = (v: any, code: string, what: string) => { if (typeof v !== 'string' || !Types.ObjectId.isValid(v)) throw err(404, code, `${what} not found`); return v; };

/**
 * G4.5 — Products & pricing from the till (behind the matrix, managers by default):
 *  · create a product (through the SAME ProductsService the dashboard uses — slugs, SKUs, plan limits, store rules all apply) and add / archive variants;
 *  · categories CRUD and product / category CSV import (the dashboard's importers, so both channels import the same way);
 *  · modifier groups ("Size", "Extras": options with price deltas, min / max choices) attached to products;
 *  · price books (another price for some variants; picked at checkout or assigned to a customer; optional active window).
 * Money is minor units in and out; every response that carries money states the currency + exponent; every write is audited.
 */
@Injectable()
export class PosCatalogAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly pos: PosService,
    private readonly auth: PosAuthorizer,
    private readonly products: ProductsService,
    private readonly variants: ProductVariantsService,
    private readonly categories: CategoriesService,
  ) {}
  private get r(): any { return this.db.repositories; }

  private async gate(req: Req, storeId: string, action: PosAction, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    return this.auth.authorize(req, { storeId, action, employeeToken: t.employee });
  }
  private async cur(storeId: string) {
    const s: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = String(s?.baseCurrency || 'USD').toUpperCase();
    return { currency, currencyExponent: isoExponent(currency) };
  }
  private audit(storeId: string, employeeId: string | null, action: string, targetId: string | null, metadata: object) {
    return this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'catalog', metadata }]);
  }
  private async ownProduct(storeId: string, productId: string) {
    oid(productId, 'PRODUCT_NOT_FOUND', 'Product');
    const p: any = await this.r.productModel.findOne({ _id: productId, storeId, isDelete: false }).lean();
    if (!p) throw err(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    return p;
  }

  // ── products and variants ────────────────────────────────────────────────────
  /** A physical product with one or more variants (prices in minor units). Through ProductsService, so it is a normal product everywhere; then the till-only fields (cost, HS code, lots, reorder point). */
  async createProduct(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.create', t);
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const name = str(body?.name, 150); if (!name) throw err(400, 'NAME_REQUIRED', 'A product needs a name');
    if (!Array.isArray(body?.variants) || !body.variants.length) throw err(400, 'VARIANTS_REQUIRED', 'Add at least one variant (a price)');
    const extras: any[] = [];
    const variants = body.variants.map((v: any) => {
      const priceMinor = minor(v?.priceMinor, 'priceMinor');
      extras.push({ costMinor: v?.costMinor !== undefined && v?.costMinor !== null ? minor(v.costMinor, 'costMinor') : null, hsCode: str(v?.hsCode, 20), trackLots: v?.trackLots === true, reorderPoint: Number.isInteger(v?.reorderPoint) && v.reorderPoint >= 0 ? v.reorderPoint : null });
      return { price: fromMinor(priceMinor, exp), sku: str(v?.sku, 64) ?? undefined, barcode: str(v?.barcode, 64) ?? undefined, stock: Number.isInteger(v?.stock) && v.stock >= 0 ? v.stock : 0, unlimitedStock: v?.unlimitedStock === true, options: Array.isArray(v?.options) ? v.options : [], isDefault: v?.isDefault === true };
    });
    let created: any;
    try {
      created = await this.products.addPhysicalProduct(req.user.userId, { storeId, name, categoryId: body?.categoryId ?? undefined, description: str(body?.description, 2000) ?? '', status: body?.status === 'draft' ? 'draft' : 'active', isListedOnSolvexo: false, variants });
    } catch (e: any) { throw err(400, 'PRODUCT_INVALID', e?.response?.message ?? e?.message ?? 'The product could not be created'); }
    const vs: any[] = created?.data?.variants ?? [];
    for (let i = 0; i < vs.length; i++) {
      const x = extras[i]; const set: any = {};
      if (x.costMinor !== null) { set.costPriceMinor = x.costMinor; set.costPrice = fromMinor(x.costMinor, exp); }
      if (x.hsCode) set.hsCode = x.hsCode;
      if (x.trackLots) set.trackLots = true;
      if (x.reorderPoint !== null) set.reorderPoint = x.reorderPoint;
      if (Object.keys(set).length) await this.r.productVariantModel.updateOne({ _id: vs[i]._id }, { $set: set });
    }
    const pid = String(created.data.product._id);
    await this.audit(storeId, a.employeeId, 'product_created', pid, { name, variants: vs.length });
    return { success: true, data: { currency, currencyExponent: exp, product: await this.productView(storeId, pid, exp) } };
  }
  private async productView(storeId: string, productId: string, exp: number) {
    const p: any = await this.r.productModel.findOne({ _id: productId, storeId }).select('name categoryId status').lean();
    const vs: any[] = await this.r.productVariantModel.find({ productId, isDelete: false }).lean();
    return { id: productId, name: p?.name, categoryId: p?.categoryId ?? null, status: p?.status, variants: vs.map((v) => ({ id: String(v._id), sku: v.sku, barcode: v.barcode ?? null, options: v.options ?? [], priceMinor: v.priceMinor ?? Math.round(v.price * 10 ** exp), costMinor: v.costPriceMinor ?? null, stock: v.stock ?? 0, unlimitedStock: !!v.unlimitedStock, trackLots: !!v.trackLots, status: v.status ?? 'active' })) };
  }
  /** Adds a variant to an existing product (same attribute names as its other variants; SKU / barcode unique in the store). */
  async addVariant(req: Req, storeId: string, productId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.create', t);
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const p = await this.ownProduct(storeId, productId);
    const priceMinor = minor(body?.priceMinor, 'priceMinor');
    const options = Array.isArray(body?.options) ? body.options.map((o: any) => ({ name: String(o?.name ?? '').trim(), value: String(o?.value ?? '').trim() })).filter((o: any) => o.name && o.value) : [];
    const siblings: any[] = await this.r.productVariantModel.find({ productId, isDelete: false }).select('options sku').lean();
    const names = (o: any[]) => o.map((x) => x.name.toLowerCase()).sort().join('|');
    if (siblings.length && names(siblings[0].options ?? []) !== names(options)) throw err(400, 'OPTIONS_MISMATCH', `Use the same attributes as the other variants (${(siblings[0].options ?? []).map((o: any) => o.name).join(', ') || 'none'})`);
    const key = (o: any[]) => o.map((x) => `${x.name.toLowerCase()}=${x.value.toLowerCase()}`).sort().join('|');
    if (siblings.some((s) => key(s.options ?? []) === key(options))) throw err(409, 'VARIANT_EXISTS', 'A variant with these attributes already exists');
    const sku = str(body?.sku, 64) ?? `${String(p._id).slice(-6).toUpperCase()}-${siblings.length + 1}`;
    if (await this.r.productVariantModel.findOne({ storeId, sku, isDelete: false }).select('_id').lean()) throw err(409, 'SKU_TAKEN', `SKU "${sku}" is already used`);
    const barcode = str(body?.barcode, 64);
    if (barcode && await this.r.productVariantModel.findOne({ storeId, barcode, isDelete: false }).select('_id').lean()) throw err(409, 'BARCODE_TAKEN', 'That barcode is already on another product');
    const store: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const costMinor = body?.costMinor !== undefined && body?.costMinor !== null ? minor(body.costMinor, 'costMinor') : null;
    const doc = await this.r.productVariantModel.create({
      productId, storeId, sku, barcode, price: fromMinor(priceMinor, exp), currency: store?.baseCurrency, options, stock: Number.isInteger(body?.stock) && body.stock >= 0 ? body.stock : 0, unlimitedStock: body?.unlimitedStock === true,
      ...(costMinor !== null ? { costPriceMinor: costMinor, costPrice: fromMinor(costMinor, exp) } : {}), hsCode: str(body?.hsCode, 20), trackLots: body?.trackLots === true, isDefault: siblings.length === 0, status: 'active', isDelete: false, committedStock: 0, damagedStock: 0,
    });
    await this.audit(storeId, a.employeeId, 'variant_added', String(doc._id), { productId, sku, priceMinor });
    return { success: true, data: { currency, currencyExponent: exp, product: await this.productView(storeId, productId, exp) } };
  }
  /** Archives a variant (never deletes: sales, lots and the ledger keep pointing at it). The last active variant of a product cannot be archived. */
  async archiveVariant(req: Req, storeId: string, productId: string, variantId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.create', t);
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    await this.ownProduct(storeId, productId);
    oid(variantId, 'VARIANT_NOT_FOUND', 'Variant');
    const active = await this.r.productVariantModel.countDocuments({ productId, isDelete: false, status: { $ne: 'archived' } });
    const v: any = await this.r.productVariantModel.findOne({ _id: variantId, productId, isDelete: false }).lean();
    if (!v) throw err(404, 'VARIANT_NOT_FOUND', 'Variant not found');
    if (active <= 1 && v.status !== 'archived') throw err(409, 'LAST_VARIANT', 'A product needs at least one active variant — archive the product instead');
    await this.r.productVariantModel.updateOne({ _id: variantId }, { $set: { status: 'archived', isDefault: false } });
    if (v.isDefault) { const next: any = await this.r.productVariantModel.findOne({ productId, isDelete: false, status: { $ne: 'archived' } }).lean(); if (next) await this.r.productVariantModel.updateOne({ _id: next._id }, { $set: { isDefault: true } }); }
    await this.audit(storeId, a.employeeId, 'variant_archived', variantId, { productId, sku: v.sku });
    return { success: true, data: { currency, currencyExponent: exp, product: await this.productView(storeId, productId, exp) } };
  }

  // ── categories + import ──────────────────────────────────────────────────────
  async categoryList(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'inventory.view', t);
    const rows: any[] = await this.r.categoryModel.find({ storeId, isDelete: false }).select('name parentId sortOrder status').sort({ sortOrder: 1, name: 1 }).lean();
    const counts: any[] = await this.r.productModel.aggregate([{ $match: { storeId, isDelete: false } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]);
    const n = new Map(counts.map((c) => [String(c._id), c.n]));
    return { success: true, data: { categories: rows.map((c) => ({ id: String(c._id), name: c.name, parentId: c.parentId ?? null, sortOrder: c.sortOrder ?? 0, status: c.status ?? 'active', products: n.get(String(c._id)) ?? 0 })) } };
  }
  async categoryCreate(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.categories.edit', t);
    const name = str(body?.name, 80); if (!name) throw err(400, 'NAME_REQUIRED', 'A category needs a name');
    try { await this.categories.addCategory(req.user.userId, 'seller', { name, storeId, parentId: body?.parentId ?? undefined } as any); }
    catch (e: any) { throw err(400, 'CATEGORY_INVALID', e?.response?.message ?? e?.message ?? 'The category could not be created'); }
    await this.audit(storeId, a.employeeId, 'category_created', null, { name });
    return this.categoryList(req, storeId, t);
  }
  async categoryUpdate(req: Req, storeId: string, id: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.categories.edit', t);
    oid(id, 'CATEGORY_NOT_FOUND', 'Category');
    const dto: any = {}; if (body?.name !== undefined) dto.name = str(body.name, 80); if (body?.sortOrder !== undefined) dto.sortOrder = Number(body.sortOrder) || 0;
    if (dto.name === null) throw err(400, 'NAME_REQUIRED', 'A category needs a name');
    try { await this.categories.updateCategory(req.user.userId, storeId, id, dto); }
    catch (e: any) { throw err(400, 'CATEGORY_INVALID', e?.response?.message ?? e?.message ?? 'The category could not be changed'); }
    await this.audit(storeId, a.employeeId, 'category_updated', id, dto);
    return this.categoryList(req, storeId, t);
  }
  async categoryDelete(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.categories.edit', t);
    oid(id, 'CATEGORY_NOT_FOUND', 'Category');
    try { await this.categories.deleteCategory(req.user.userId, storeId, id); }
    catch (e: any) { throw err(409, 'CATEGORY_IN_USE', e?.response?.message ?? e?.message ?? 'The category could not be deleted'); }
    await this.audit(storeId, a.employeeId, 'category_deleted', id, {});
    return this.categoryList(req, storeId, t);
  }
  /** CSV import of products or categories — the dashboard's importers (same columns, same validation, same report of what was created / updated / refused). */
  async importCsv(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.import', t);
    const text = typeof body?.csv === 'string' ? body.csv : '';
    if (!text.trim()) throw err(400, 'CSV_REQUIRED', 'Paste or attach the CSV text');
    if (text.length > 2_000_000) throw err(400, 'CSV_TOO_LARGE', 'The file is too large (2 MB at most)');
    const kind = body?.kind === 'categories' ? 'categories' : 'products';
    const out: any = kind === 'categories'
      ? await this.categories.importCsv(req.user.userId, storeId, text)
      : await this.products.importProductsCsv(req.user.userId, storeId, text, (s, p, v, dto) => this.variants.updateVariant(s, p, v, dto));
    await this.audit(storeId, a.employeeId, `${kind}_imported`, null, { summary: out?.data?.summary ?? out?.summary ?? null });
    return { success: true, data: out?.data ?? out };
  }

  // ── modifier groups ──────────────────────────────────────────────────────────
  private groupView(g: any) {
    return { id: String(g._id), name: g.name, minSelect: g.minSelect ?? 0, maxSelect: g.maxSelect ?? 1, productIds: g.productIds ?? [], active: g.active !== false, sortOrder: g.sortOrder ?? 0, options: (g.options ?? []).map((o: any) => ({ id: String(o._id), name: o.name, priceDeltaMinor: Number(o.priceDeltaMinor ?? 0), active: o.active !== false })) };
  }
  private groupInput(body: any, partial: boolean) {
    const set: any = {};
    if (!partial || body?.name !== undefined) { const n = str(body?.name, 60); if (!n) throw err(400, 'NAME_REQUIRED', 'A modifier group needs a name'); set.name = n; }
    const min = body?.minSelect ?? (partial ? undefined : 0); const max = body?.maxSelect ?? (partial ? undefined : 1);
    if (min !== undefined) { if (!Number.isInteger(min) || min < 0 || min > 20) throw err(400, 'INVALID_GROUP', 'minSelect must be 0–20'); set.minSelect = min; }
    if (max !== undefined) { if (!Number.isInteger(max) || max < 1 || max > 20) throw err(400, 'INVALID_GROUP', 'maxSelect must be 1–20'); set.maxSelect = max; }
    if (body?.options !== undefined) {
      if (!Array.isArray(body.options) || body.options.length === 0 || body.options.length > 50) throw err(400, 'OPTIONS_REQUIRED', 'A group needs 1–50 options');
      set.options = body.options.map((o: any) => { const n = str(o?.name, 60); if (!n) throw err(400, 'NAME_REQUIRED', 'Each option needs a name'); return { ...(o?.id && Types.ObjectId.isValid(o.id) ? { _id: new Types.ObjectId(o.id) } : {}), name: n, priceDeltaMinor: minor(o?.priceDeltaMinor ?? 0, 'priceDeltaMinor', true), active: o?.active !== false }; });
    } else if (!partial) throw err(400, 'OPTIONS_REQUIRED', 'A group needs 1–50 options');
    if (body?.productIds !== undefined) { if (!Array.isArray(body.productIds)) throw err(400, 'INVALID_GROUP', 'productIds must be a list'); set.productIds = [...new Set(body.productIds.map(String))]; }
    if (body?.active !== undefined) set.active = body.active !== false;
    if (body?.sortOrder !== undefined) set.sortOrder = Number(body.sortOrder) || 0;
    return set;
  }
  private async checkGroup(storeId: string, set: any, current?: any) {
    const min = set.minSelect ?? current?.minSelect ?? 0; const max = set.maxSelect ?? current?.maxSelect ?? 1;
    if (min > max) throw err(400, 'INVALID_GROUP', 'minSelect cannot be more than maxSelect');
    const opts = set.options ?? current?.options ?? [];
    if (min > opts.filter((o: any) => o.active !== false).length) throw err(400, 'INVALID_GROUP', 'There are fewer active options than must be chosen');
    for (const pid of set.productIds ?? []) await this.ownProduct(storeId, pid);
  }
  async modifierGroups(req: Req, storeId: string, q: any, t: Tokens) {
    await this.gate(req, storeId, 'inventory.view', t); // the till needs them to sell
    const filter: any = { storeId }; if (q?.productId) filter.productIds = String(q.productId); if (q?.all !== 'true') filter.active = true;
    const rows: any[] = await this.r.posModifierGroupModel.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
    return { success: true, data: { ...(await this.cur(storeId)), groups: rows.map((g) => this.groupView(g)) } };
  }
  async modifierCreate(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.modifiers.edit', t);
    const set = this.groupInput(body, false); await this.checkGroup(storeId, set);
    const g = await this.r.posModifierGroupModel.create({ storeId, ...set });
    await this.audit(storeId, a.employeeId, 'modifier_group_created', String(g._id), { name: set.name, options: set.options.length, products: (set.productIds ?? []).length });
    return { success: true, data: { ...(await this.cur(storeId)), group: this.groupView(g.toObject()) } };
  }
  async modifierUpdate(req: Req, storeId: string, id: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.modifiers.edit', t);
    oid(id, 'MODIFIER_GROUP_NOT_FOUND', 'Modifier group');
    const cur: any = await this.r.posModifierGroupModel.findOne({ _id: id, storeId }).lean();
    if (!cur) throw err(404, 'MODIFIER_GROUP_NOT_FOUND', 'Modifier group not found');
    const set = this.groupInput(body, true); await this.checkGroup(storeId, set, cur);
    const g: any = await this.r.posModifierGroupModel.findOneAndUpdate({ _id: id, storeId }, { $set: set }, { new: true }).lean();
    await this.audit(storeId, a.employeeId, 'modifier_group_updated', id, { fields: Object.keys(set) });
    return { success: true, data: { ...(await this.cur(storeId)), group: this.groupView(g) } };
  }

  // ── price books ──────────────────────────────────────────────────────────────
  /**
   * G4.8: besides the stored instants (`startsAt` / `endsAt`, unchanged), every book says WHEN it is valid as UTC instants computed in the STORE's time
   * zone (`validFromUtc` = start of its first store day, `validToUtc` = end of its last store day, exclusive) and as store days, so a till whose clock is
   * in another zone switches books at the store's midnight.
   */
  private bookView(b: any, tz: string) {
    const from = b.startsAt ? new Date(b.startsAt) : null; const to = b.endsAt ? new Date(b.endsAt) : null;
    return {
      id: String(b._id), name: b.name, active: b.active !== false, startsAt: b.startsAt ?? null, endsAt: b.endsAt ?? null, note: b.note ?? null,
      entries: (b.entries ?? []).map((e: any) => ({ variantId: e.variantId, priceMinor: Number(e.priceMinor) })),
      timeZone: tz,
      validFromUtc: from ? from.toISOString() : null, validToUtc: to ? to.toISOString() : null,
      validFromDay: from ? localKey(from, tz) : null, validToDay: to ? localKey(new Date(to.getTime() - 1), tz) : null,
    };
  }
  private async bookInput(storeId: string, body: any, partial: boolean) {
    const set: any = {};
    // G4.8: store days — `validFrom` = the start of that day, `validTo` = the END of that day, both in the store's time zone (null clears)
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (body?.validFrom !== undefined || body?.validTo !== undefined) {
      const tz = await this.pos.storeTz(storeId);
      for (const [k, field, edge] of [['validFrom', 'startsAt', 'start'], ['validTo', 'endsAt', 'end']] as const) {
        const v = body?.[k];
        if (v === undefined) continue;
        if (v !== null && (typeof v !== 'string' || !day.test(v))) throw err(400, 'INVALID_DATE', `${k} must be a store day YYYY-MM-DD`);
        set[field] = v === null ? null : localDay(v, tz)[edge];
      }
      body = { ...body, startsAt: undefined, endsAt: undefined }; // the store days win over instants sent with them
    }
    if (!partial || body?.name !== undefined) { const n = str(body?.name, 60); if (!n) throw err(400, 'NAME_REQUIRED', 'A price book needs a name'); set.name = n; }
    for (const k of ['startsAt', 'endsAt'] as const) if (body?.[k] !== undefined && set[k] === undefined) { if (body[k] === null) set[k] = null; else { const d = new Date(body[k]); if (Number.isNaN(d.getTime())) throw err(400, 'INVALID_DATE', `${k} is not a valid date`); set[k] = d; } }
    if (set.startsAt && set.endsAt && set.endsAt <= set.startsAt) throw err(400, 'INVALID_DATE', 'The end must be after the start');
    if (body?.active !== undefined) set.active = body.active !== false;
    if (body?.note !== undefined) set.note = str(body.note, 300);
    if (body?.entries !== undefined) {
      if (!Array.isArray(body.entries) || body.entries.length > 5000) throw err(400, 'INVALID_ENTRIES', 'entries must be a list (at most 5,000)');
      const seen = new Set<string>();
      set.entries = body.entries.map((e: any) => { const v = String(e?.variantId ?? ''); if (seen.has(v)) throw err(400, 'DUPLICATE_ENTRY', 'A variant appears twice'); seen.add(v); return { variantId: v, priceMinor: minor(e?.priceMinor, 'priceMinor') }; });
      const ids = [...seen].filter((x) => Types.ObjectId.isValid(x));
      if (ids.length !== seen.size) throw err(404, 'VARIANT_NOT_FOUND', 'A variant in the price book was not found');
      const found: any[] = await this.r.productVariantModel.find({ _id: { $in: ids }, isDelete: false }).select('productId').lean();
      const prods = new Set((await this.r.productModel.find({ _id: { $in: found.map((f) => f.productId) }, storeId, isDelete: false }).select('_id').lean()).map((p: any) => String(p._id)));
      if (found.length !== ids.length || found.some((f) => !prods.has(String(f.productId)))) throw err(404, 'VARIANT_NOT_FOUND', 'A variant in the price book is not in this store');
    } else if (!partial) set.entries = [];
    return set;
  }
  async priceBooks(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'inventory.view', t); // the till lists them at checkout
    const rows: any[] = await this.r.posPriceBookModel.find({ storeId }).sort({ name: 1 }).lean();
    const now = new Date();
    const tz = await this.pos.storeTz(storeId);
    return { success: true, data: { ...(await this.cur(storeId)), books: rows.map((b) => ({ ...this.bookView(b, tz), inForce: b.active !== false && (!b.startsAt || b.startsAt <= now) && (!b.endsAt || b.endsAt > now) })) } };
  }
  async priceBookCreate(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.pricebooks.edit', t);
    const set = await this.bookInput(storeId, body, false);
    const b = await this.r.posPriceBookModel.create({ storeId, ...set });
    await this.audit(storeId, a.employeeId, 'price_book_created', String(b._id), { name: set.name, entries: set.entries.length });
    return { success: true, data: { ...(await this.cur(storeId)), book: this.bookView(b.toObject(), await this.pos.storeTz(storeId)) } };
  }
  async priceBookUpdate(req: Req, storeId: string, id: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.pricebooks.edit', t);
    oid(id, 'PRICE_BOOK_NOT_FOUND', 'Price book');
    const cur: any = await this.r.posPriceBookModel.findOne({ _id: id, storeId }).lean();
    if (!cur) throw err(404, 'PRICE_BOOK_NOT_FOUND', 'Price book not found');
    const set = await this.bookInput(storeId, body, true);
    const s2 = set.startsAt !== undefined ? set.startsAt : cur.startsAt; const e2 = set.endsAt !== undefined ? set.endsAt : cur.endsAt;
    if (s2 && e2 && new Date(e2) <= new Date(s2)) throw err(400, 'INVALID_DATE', 'The end must be after the start');
    const b: any = await this.r.posPriceBookModel.findOneAndUpdate({ _id: id, storeId }, { $set: set }, { new: true }).lean();
    await this.audit(storeId, a.employeeId, 'price_book_updated', id, { fields: Object.keys(set), entries: set.entries?.length });
    return { success: true, data: { ...(await this.cur(storeId)), book: this.bookView(b, await this.pos.storeTz(storeId)) } };
  }
  /** Assign (or clear with null) a customer's price book. */
  async assignBook(req: Req, storeId: string, customerId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.pricebooks.edit', t);
    oid(customerId, 'CUSTOMER_NOT_FOUND', 'Customer');
    const bookId = body?.priceBookId ?? null;
    if (bookId !== null) { oid(bookId, 'PRICE_BOOK_NOT_FOUND', 'Price book'); if (!await this.r.posPriceBookModel.findOne({ _id: bookId, storeId }).select('_id').lean()) throw err(404, 'PRICE_BOOK_NOT_FOUND', 'Price book not found'); }
    const c = await this.r.posCustomerModel.findOneAndUpdate({ _id: customerId, storeId }, { $set: { priceBookId: bookId } }, { new: true }).lean();
    if (!c) throw err(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    await this.audit(storeId, a.employeeId, 'customer_price_book_set', customerId, { priceBookId: bookId });
    return { success: true, data: { customerId, priceBookId: bookId } };
  }
}
