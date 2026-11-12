/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { fromMinor, isoExponent, isSafeMinor } from '@/common/money-minor.util';
import { UploadService } from '@/upload/upload.service';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAction } from './pos-permissions.config';

type Req = any;
interface Tokens { employee?: string }
const err = (status: 400 | 403 | 404 | 409, code: string, message: string, extra: object = {}) => {
  const body = { statusCode: status, code, message, ...extra };
  return status === 404 ? new NotFoundException(body) : status === 409 ? new ConflictException(body) : status === 403 ? new ForbiddenException(body) : new BadRequestException(body);
};
const str = (v: any, max = 120): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Product images: JPEG / PNG / WebP by CONTENT (never by name or the client's Content-Type), at most 8 MB; stored resized to ≤ 1600 px. */
export const PRODUCT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_COUNT = 10;
export function detectImageMime(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
/** A small square thumbnail URL for the till (Cloudinary delivery transform; any other URL is returned unchanged). */
export function thumbUrl(url: string, size = 240): string {
  return /res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url) ? url.replace('/image/upload/', `/image/upload/c_fill,w_${size},h_${size},q_auto,f_auto/`) : url;
}

/**
 * G5.2 — the product page at the till and editing an existing product: name, description, category, status; a variant's SKU, cost and reorder point
 * (price / barcode / HS code stay on the G2.6 catalog route with its approval rules); product images (upload, remove, make primary). Behind the matrix
 * (`catalog.edit`, managers by default), every change audited with before / after. Cost obeys "hide costs from managers": the view's cost keys are removed
 * by the cost interceptor, and a manager cannot change cost while it is hidden (`COSTS_HIDDEN`).
 */
@Injectable()
export class PosProductEditService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer, private readonly upload: UploadService) {}
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
  private audit(storeId: string, employeeId: string | null, action: string, targetId: string, metadata: object) {
    return this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'catalog', metadata }]);
  }
  private async own(storeId: string, productId: string) {
    if (!Types.ObjectId.isValid(productId)) throw err(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    const p: any = await this.r.productModel.findOne({ _id: productId, storeId, isDelete: false }).lean();
    if (!p) throw err(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    return p;
  }

  /** The product page: everything the till shows about one product (cost keys are stripped for a manager when costs are hidden). */
  async view(req: Req, storeId: string, productId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'inventory.view', t);
    const p = await this.own(storeId, productId);
    const { currency, currencyExponent: exp } = await this.cur(storeId);
    const [vs, cat, locs]: any[] = await Promise.all([
      this.r.productVariantModel.find({ productId, isDelete: false }).sort({ isDefault: -1, createdAt: 1 }).lean(),
      p.categoryId && Types.ObjectId.isValid(String(p.categoryId)) ? this.r.categoryModel?.findById(p.categoryId).select('name').lean() : null,
      this.r.variantLocationStockModel?.aggregate([{ $match: { storeId, productId } }, { $group: { _id: '$locationId', stock: { $sum: '$stock' } } }]) ?? [],
    ]);
    const names = new Map<string, string>();
    const ids = (locs as any[]).map((l) => String(l._id)).filter((i) => Types.ObjectId.isValid(i));
    if (ids.length && this.r.storeLocationModel) for (const l of await this.r.storeLocationModel.find({ _id: { $in: ids } }).select('name').lean()) names.set(String((l as any)._id), (l as any).name);
    const seesCost = a.role === 'owner' || a.role === 'manager';
    return {
      success: true,
      data: {
        currency, currencyExponent: exp,
        product: {
          id: String(p._id), name: p.name, description: p.description ?? '', categoryId: p.categoryId ?? null, categoryName: cat?.name ?? null, status: p.status,
          images: ((p.images ?? []) as string[]).map((url) => ({ url, thumbUrl: thumbUrl(url) })),
          variants: (vs as any[]).map((v) => ({
            id: String(v._id), sku: v.sku ?? null, barcode: v.barcode ?? null, options: v.options ?? [], hsCode: v.hsCode ?? null, isDefault: !!v.isDefault, status: v.status ?? 'active',
            priceMinor: v.priceMinor ?? Math.round((v.price ?? 0) * 10 ** exp),
            ...(seesCost ? { costMinor: v.costPriceMinor ?? null } : {}),
            stock: v.stock ?? 0, unlimitedStock: !!v.unlimitedStock, reorderPoint: v.reorderPoint ?? null, trackLots: !!v.trackLots,
          })),
          stockByLocation: (locs as any[]).map((l) => ({ locationId: l._id ? String(l._id) : null, name: l._id ? names.get(String(l._id)) ?? 'Location' : 'Unassigned', stock: l.stock ?? 0 })),
        },
        canEdit: a.role === 'owner' || a.role === 'manager',
      },
    };
  }

  /** Name, description, category, status — audited with what changed. */
  async update(req: Req, storeId: string, productId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.edit', t);
    const p = await this.own(storeId, productId);
    const set: any = {};
    if (body?.name !== undefined) { const n = str(body.name, 150); if (!n) throw err(400, 'NAME_REQUIRED', 'A product needs a name'); set.name = n; }
    if (body?.description !== undefined) set.description = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : '';
    if (body?.categoryId !== undefined) {
      if (body.categoryId === null) set.categoryId = null;
      else {
        if (!Types.ObjectId.isValid(String(body.categoryId))) throw err(404, 'CATEGORY_NOT_FOUND', 'Category not found');
        const c = this.r.categoryModel ? await this.r.categoryModel.findOne({ _id: body.categoryId, $or: [{ storeId }, { storeId: null }, { storeId: { $exists: false } }] }).select('_id').lean() : { _id: body.categoryId };
        if (!c) throw err(404, 'CATEGORY_NOT_FOUND', 'Category not found');
        set.categoryId = String(body.categoryId);
      }
    }
    if (body?.status !== undefined) { if (!['active', 'draft'].includes(body.status)) throw err(400, 'STATUS_INVALID', 'status must be active or draft'); set.status = body.status; }
    const changed = Object.keys(set).filter((k) => String(p[k] ?? '') !== String(set[k] ?? ''));
    if (changed.length) {
      await this.r.productModel.updateOne({ _id: productId }, { $set: set });
      await this.audit(storeId, a.employeeId, 'product_updated', productId, { before: Object.fromEntries(changed.map((k) => [k, p[k] ?? null])), after: Object.fromEntries(changed.map((k) => [k, set[k]])) });
    }
    return this.view(req, storeId, productId, t);
  }

  /** A variant's SKU (unique in the store), cost (not while hidden from a manager) and reorder point — audited. */
  async updateVariant(req: Req, storeId: string, productId: string, variantId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.edit', t);
    await this.own(storeId, productId);
    if (!Types.ObjectId.isValid(variantId)) throw err(404, 'VARIANT_NOT_FOUND', 'Variant not found');
    const v: any = await this.r.productVariantModel.findOne({ _id: variantId, productId, isDelete: false }).lean();
    if (!v) throw err(404, 'VARIANT_NOT_FOUND', 'Variant not found');
    const { currencyExponent: exp } = await this.cur(storeId);
    const set: any = {}; const before: any = {}; const after: any = {};
    if (body?.sku !== undefined) {
      const sku = str(body.sku, 64); if (!sku) throw err(400, 'SKU_REQUIRED', 'A SKU cannot be empty');
      if (sku !== v.sku && await this.r.productVariantModel.findOne({ storeId, sku, isDelete: false, _id: { $ne: variantId } }).select('_id').lean()) throw err(409, 'SKU_TAKEN', `SKU "${sku}" is already used`);
      if (sku !== v.sku) { set.sku = sku; before.sku = v.sku ?? null; after.sku = sku; }
    }
    if (body?.costMinor !== undefined) {
      if (a.role !== 'owner') {
        const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('securityPrefs').lean();
        if (s?.securityPrefs?.hideCostsFromManagers === true) throw err(403, 'COSTS_HIDDEN', 'The owner hides costs from managers — only the owner can change a cost');
      }
      const c = body.costMinor;
      if (c !== null && (!isSafeMinor(c) || c < 0)) throw err(400, 'INVALID_AMOUNT', 'costMinor must be a whole number of minor units (0 or more), or null');
      if ((v.costPriceMinor ?? null) !== c) { set.costPriceMinor = c; set.costPrice = c === null ? null : fromMinor(c, exp); before.costMinor = v.costPriceMinor ?? null; after.costMinor = c; }
    }
    if (body?.reorderPoint !== undefined) {
      const rp = body.reorderPoint;
      if (rp !== null && !(Number.isInteger(rp) && rp >= 0)) throw err(400, 'REORDER_INVALID', 'reorderPoint must be a whole number (0 or more), or null');
      if ((v.reorderPoint ?? null) !== rp) { set.reorderPoint = rp; before.reorderPoint = v.reorderPoint ?? null; after.reorderPoint = rp; }
    }
    if (Object.keys(set).length) {
      await this.r.productVariantModel.updateOne({ _id: variantId }, { $set: set });
      await this.audit(storeId, a.employeeId, 'variant_updated', variantId, { productId, before, after });
    }
    return this.view(req, storeId, productId, t);
  }

  async addImage(req: Req, storeId: string, productId: string, file: Express.Multer.File | undefined, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.edit', t);
    const p = await this.own(storeId, productId);
    if (!file?.buffer) throw err(400, 'FILE_REQUIRED', 'Choose a photo');
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) throw err(400, 'FILE_TOO_LARGE', 'Photos can be at most 8 MB', { maxBytes: PRODUCT_IMAGE_MAX_BYTES });
    const mime = detectImageMime(file.buffer);
    if (!mime) throw err(400, 'FILE_TYPE', 'Only JPEG, PNG or WebP photos are accepted');
    if ((p.images ?? []).length >= PRODUCT_IMAGE_MAX_COUNT) throw err(409, 'TOO_MANY_IMAGES', `A product can have at most ${PRODUCT_IMAGE_MAX_COUNT} photos`);
    const up = await this.upload.uploadFile({ ...file, mimetype: mime } as Express.Multer.File, { folder: `products/${storeId}`, maxDimension: 1600 });
    await this.r.productModel.updateOne({ _id: productId }, { $push: { images: up.url } });
    await this.audit(storeId, a.employeeId, 'product_image_added', productId, { url: up.url, mimeType: mime, fileSize: file.size });
    return this.view(req, storeId, productId, t);
  }

  async removeImage(req: Req, storeId: string, productId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.edit', t);
    const p = await this.own(storeId, productId);
    const url = typeof body?.url === 'string' ? body.url : '';
    if (!(p.images ?? []).includes(url)) throw err(404, 'IMAGE_NOT_FOUND', 'That photo is not on this product');
    await this.r.productModel.updateOne({ _id: productId }, { $pull: { images: url } });
    await this.audit(storeId, a.employeeId, 'product_image_removed', productId, { url });
    return this.view(req, storeId, productId, t);
  }

  /** Moves a photo to the front (the main photo on the till and the storefront). */
  async primaryImage(req: Req, storeId: string, productId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'catalog.edit', t);
    const p = await this.own(storeId, productId);
    const url = typeof body?.url === 'string' ? body.url : '';
    const imgs: string[] = p.images ?? [];
    if (!imgs.includes(url)) throw err(404, 'IMAGE_NOT_FOUND', 'That photo is not on this product');
    if (imgs[0] !== url) {
      await this.r.productModel.updateOne({ _id: productId }, { $set: { images: [url, ...imgs.filter((x) => x !== url)] } });
      await this.audit(storeId, a.employeeId, 'product_image_primary', productId, { url });
    }
    return this.view(req, storeId, productId, t);
  }
}
