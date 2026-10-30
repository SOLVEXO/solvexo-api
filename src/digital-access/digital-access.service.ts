import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { DigitalAccess, DigitalAccessDocument, DeliveryLog, DeliveryDocument } from './digital-access.schema';

export interface CanResult {
  allowed: boolean;
  reason?: string;
  access?: DigitalAccessDocument;
}

const DEAD_ITEM = ['cancelled', 'refunded'];

@Injectable()
export class DigitalAccessService {
  constructor(
    private readonly db: DatabaseService,
    @InjectModel(DigitalAccess.name) readonly accessModel: Model<DigitalAccessDocument>,
    @InjectModel(DeliveryLog.name) readonly logModel: Model<DeliveryDocument>,
  ) {}

  /** expiry date for a product's link-expiry setting, counted from now */
  private expiryFor(product: any): Date | null {
    const days = product?.digital?.linkExpiryDays;
    return days ? new Date(Date.now() + days * 86_400_000) : null;
  }

  /**
   * Idempotent grant for every digital item of a PAID order that belongs to `storeId`.
   * Safe to call repeatedly (unique index + $setOnInsert); never re-activates a revoked record.
   */
  async grantForOrder(order: any, storeId: string): Promise<number> {
    if (!order?.isPaid) return 0;
    const { productModel } = this.db.repositories;
    let granted = 0;
    for (const so of order.sellerOrders ?? []) {
      if (so.storeId !== storeId) continue;
      for (const item of so.items ?? []) {
        if (item.type !== 'digital' || DEAD_ITEM.includes(item.status)) continue;
        const product: any = await productModel.findOne({ _id: item.productId, storeId }).select('digital').lean();
        const res = await this.accessModel.updateOne(
          {
            storeId,
            customerId: order.userId,
            resourceKind: 'file',
            resourceRef: String(item.productId),
            sourceOrderItemId: String(item._id),
          },
          {
            $setOnInsert: {
              grantedBy: 'purchase',
              sourceOrderId: String(order._id),
              expiresAt: this.expiryFor(product),
              status: 'active',
              audit: [{ at: new Date(), action: 'granted', by: 'system', note: 'paid order' }],
            },
          },
          { upsert: true },
        );
        if (res.upsertedCount) granted++;
      }
    }
    return granted;
  }

  /** Grants from every paid order of this customer in this store (covers orders placed before DigitalAccess existed). */
  async ensureFromOrders(storeId: string, customerId: string, productId?: string): Promise<void> {
    const { orderModel } = this.db.repositories;
    const filter: any = { userId: customerId, isPaid: true, isDelete: false, 'sellerOrders.storeId': storeId };
    if (productId) filter['sellerOrders.items.productId'] = productId;
    const orders = await orderModel.find(filter).limit(200).lean();
    for (const o of orders) await this.grantForOrder(o, storeId);
  }

  /** Sync an access record with its source order item: refund / cancel => revoked, past expiry => expired. */
  private async reconcile(access: DigitalAccessDocument): Promise<DigitalAccessDocument> {
    if (access.status === 'revoked') return access;
    if (access.expiresAt && access.expiresAt.getTime() < Date.now()) {
      if (access.status !== 'expired') {
        access.status = 'expired';
        await access.save();
      }
      return access;
    }
    if (access.grantedBy === 'purchase' && access.sourceOrderId) {
      const order: any = await this.db.repositories.orderModel.findOne({ _id: access.sourceOrderId }).lean();
      const item = order?.sellerOrders?.flatMap((s: any) => s.items).find((i: any) => String(i._id) === access.sourceOrderItemId);
      if (!order || order.isDelete || !item || DEAD_ITEM.includes(item.status)) {
        await this.revoke(access, 'system', 'order item cancelled or refunded');
      }
    }
    return access;
  }

  /** THE gate. Server-side only, always scoped by storeId + customer. */
  async can(storeId: string, customerId: string, resource: { kind: string; ref: string }): Promise<CanResult> {
    if (!storeId || !customerId) return { allowed: false, reason: 'no_context' };
    if (resource.kind === 'file') await this.ensureFromOrders(storeId, customerId, resource.ref);
    const records = await this.accessModel.find({ storeId, customerId, resourceKind: resource.kind, resourceRef: resource.ref });
    let reason = 'no_access';
    for (const r of records) {
      const fresh = await this.reconcile(r);
      if (fresh.status === 'active') return { allowed: true, access: fresh };
      reason = fresh.status;
    }
    return { allowed: false, reason };
  }

  async revoke(access: DigitalAccessDocument, by: string, note: string): Promise<void> {
    access.status = 'revoked';
    access.audit.push({ at: new Date(), action: 'revoked', by, note });
    await access.save();
  }

  /** Revoke every purchase access created by an order (refund / chargeback / cancel). */
  async revokeForOrder(storeId: string, orderId: string, note = 'order refunded'): Promise<number> {
    const res = await this.accessModel.updateMany(
      { storeId, sourceOrderId: orderId, status: { $ne: 'revoked' } },
      { $set: { status: 'revoked' }, $push: { audit: { at: new Date(), action: 'revoked', by: 'system', note } } },
    );
    return res.modifiedCount;
  }

  // ---- seller actions (store scoped; wrong store => 404, no existence leak) ----

  private async findForStore(storeId: string, id: string): Promise<DigitalAccessDocument> {
    const a = await this.accessModel.findOne({ _id: id, storeId }).catch(() => null);
    if (!a) throw new NotFoundException('Access not found');
    return a;
  }

  async sellerRevoke(storeId: string, id: string, by: string) {
    const a = await this.findForStore(storeId, id);
    await this.revoke(a, by, 'seller revoked');
    return { success: true };
  }

  async sellerResetLimit(storeId: string, id: string, by: string) {
    const a = await this.findForStore(storeId, id);
    a.downloadCount = 0;
    a.audit.push({ at: new Date(), action: 'limit_reset', by, note: '' });
    await a.save();
    return { success: true };
  }

  /** Resend = reactivate (unless revoked by a refund) and restart the expiry from now. */
  async sellerResend(storeId: string, id: string, by: string) {
    const a = await this.findForStore(storeId, id);
    if (a.status === 'revoked') throw new ForbiddenException('Access was revoked; grant it again manually');
    const product: any = await this.db.repositories.productModel.findOne({ _id: a.resourceRef, storeId }).select('digital').lean();
    a.status = 'active';
    a.expiresAt = this.expiryFor(product);
    a.audit.push({ at: new Date(), action: 'resent', by, note: '' });
    await a.save();
    return { success: true };
  }

  async listForOrder(storeId: string, orderId: string) {
    return this.accessModel.find({ storeId, sourceOrderId: orderId }).lean();
  }

  async deliveryLog(storeId: string, limit = 50, customerId?: string) {
    const filter: any = { storeId };
    if (customerId) filter.customerId = customerId;
    return this.logModel.find(filter).sort({ at: -1 }).limit(Math.min(limit, 200)).lean();
  }

  /** Buyer library: every active access with its product's visible (non-archived) files. */
  async library(storeId: string, customerId: string) {
    await this.ensureFromOrders(storeId, customerId);
    const docs = await this.accessModel.find({ storeId, customerId, resourceKind: 'file' });
    const out: any[] = [];
    for (const doc of docs) {
      const fresh = await this.reconcile(doc);
      if (fresh.status !== 'active') continue;
      const p: any = await this.db.repositories.productModel.findOne({ _id: doc.resourceRef, storeId }).select('name images digital').lean();
      if (!p?.digital) continue;
      out.push({
        accessId: String(doc._id),
        productId: String(p._id),
        name: p.name,
        image: p.images?.[0] ?? null,
        expiresAt: doc.expiresAt,
        downloadLimit: p.digital.downloadLimit,
        downloadsUsed: doc.downloadCount,
        files: (p.digital.files ?? [])
          .map((f: any, fileIndex: number) => ({ fileIndex, name: f.name, label: f.label ?? null, version: f.version ?? null, updatedAt: f.updatedAt ?? null, changelog: f.changelog ?? null, size: f.size ?? null, archived: !!f.archived, position: f.position ?? 0 }))
          .filter((f: any) => !f.archived)
          .sort((a: any, b: any) => a.position - b.position),
      });
    }
    return out;
  }
}
