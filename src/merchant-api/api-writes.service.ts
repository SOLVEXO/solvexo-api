/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { InventoryService } from '../inventory/inventory.service';
import { ApiIdempotency, ApiIdempotencyDocument } from './merchant-api.schema';

export interface ApiCaller { id: string; storeId: string }
const KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const isOid = (v: unknown) => typeof v === 'string' && Types.ObjectId.isValid(v) && /^[a-f0-9]{24}$/i.test(v);
const hashBody = (o: unknown) => createHash('sha256').update(JSON.stringify(o ?? {})).digest('hex');

/** Write endpoints of the merchant API: only behind an explicit write_* scope, the token's own store only, one effect per Idempotency-Key, audited. */
@Injectable()
export class ApiWritesService {
  constructor(
    @InjectModel(ApiIdempotency.name) private readonly idem: Model<ApiIdempotencyDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly inventory: InventoryService,
  ) {}

  /** Runs `fn` at most once per (token, key). A replay returns the stored answer; the same key with another body is refused. */
  async once<T>(caller: ApiCaller, key: string | undefined, body: unknown, fn: () => Promise<T>): Promise<{ replayed: boolean; result: T }> {
    if (!key || !KEY_RE.test(key)) throw new BadRequestException('Send an Idempotency-Key header (8 to 100 letters, digits, . _ : -)');
    const requestHash = hashBody(body);
    try {
      await this.idem.create({ tokenId: caller.id, key, requestHash, status: 'processing' });
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      const row: any = await this.idem.findOne({ tokenId: caller.id, key }).lean();
      if (!row) throw new ConflictException('Please retry');
      if (row.requestHash !== requestHash) throw new UnprocessableEntityException('This Idempotency-Key was already used with a different request');
      if (row.status === 'done') return { replayed: true, result: row.response as T };
      throw new ConflictException('A request with this Idempotency-Key is still being processed');
    }
    try {
      const result = await fn();
      await this.idem.updateOne({ tokenId: caller.id, key }, { $set: { status: 'done', response: result as any } });
      return { replayed: false, result };
    } catch (e) {
      await this.idem.deleteOne({ tokenId: caller.id, key, status: 'processing' }); // a failed attempt may be retried with the same key
      throw e;
    }
  }

  private audit(caller: ApiCaller, action: string, description: string, targetId: string, targetType: string) {
    return this.activity.log({ storeId: caller.storeId, category: 'api_token', action, description, actorId: caller.id, actorRole: 'api_token', targetId, targetType } as any).catch(() => undefined);
  }

  /** Product: status and tags only (an allow-list; nothing else can be written through the API yet). */
  async updateProduct(caller: ApiCaller, productId: string, body: any) {
    if (!isOid(productId)) throw new NotFoundException('Product not found');
    const set: Record<string, unknown> = {};
    if (body?.status !== undefined) { if (!['active', 'inactive'].includes(body.status)) throw new BadRequestException('status must be active or inactive'); set.status = body.status; }
    if (body?.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 250) throw new BadRequestException('tags must be a list of at most 250 strings');
      set.tags = [...new Set(body.tags.map((t: unknown) => String(t).trim().slice(0, 255)).filter(Boolean))];
    }
    if (Object.keys(set).length === 0) throw new BadRequestException('Send status and/or tags');
    const p = await (this.db.repositories as any).productModel.findOneAndUpdate({ _id: productId, storeId: caller.storeId, isDelete: false }, { $set: set }, { new: true }).select('name status tags').lean();
    if (!p) throw new NotFoundException('Product not found');
    void this.audit(caller, 'api_product_update', `Product updated through the API (${Object.keys(set).join(', ')})`, productId, 'product');
    return { id: productId, name: p.name, status: p.status, tags: p.tags ?? [] };
  }

  /** Stock: relative change through the same service the dashboard uses (location rows, history row, floor at zero). */
  async adjustInventory(caller: ApiCaller, body: any) {
    const variantId = String(body?.variantId ?? '');
    const delta = Number(body?.delta);
    if (!isOid(variantId)) throw new BadRequestException('variantId is invalid');
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000) throw new BadRequestException('delta must be a whole number other than 0 (at most 10000)');
    const reason = ['restocked', 'correction', 'other'].includes(body?.reason) ? body.reason : 'correction';
    const r = this.db.repositories as any;
    const variant: any = await r.productVariantModel.findOne({ _id: variantId, isDelete: false }).select('productId storeId').lean();
    const product: any = variant ? await r.productModel.findOne({ _id: variant.productId, storeId: caller.storeId, isDelete: false }).select('_id').lean() : null;
    if (!variant || !product) throw new NotFoundException('Variant not found');
    const store: any = await r.storeModel.findOne({ _id: caller.storeId, isDelete: false }).select('sellerId').lean();
    if (!store) throw new NotFoundException('Store not found');
    const note = typeof body?.note === 'string' ? body.note.slice(0, 200) : undefined;
    const res: any = await this.inventory.adjustStock(String(store.sellerId), caller.storeId, variantId, delta, reason, note ? `API: ${note}` : 'API adjustment');
    void this.audit(caller, 'api_inventory_adjust', `Stock ${delta > 0 ? '+' : ''}${delta} through the API (${reason})`, variantId, 'variant');
    return { variantId, delta, reason, result: res?.data ?? res?.message ?? 'ok' };
  }
}
