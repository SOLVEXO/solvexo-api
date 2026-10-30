import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { DigitalAccess, DigitalAccessDocument, DeliveryLog, DeliveryDocument } from './digital-access.schema';
import { DigitalMailerService } from './digital-mailer.service';
import { ORDER_CHANGED, ORDER_DISPUTED, orderEvents } from '../common/order-events';

export interface CanResult {
  allowed: boolean;
  reason?: string;
  access?: DigitalAccessDocument;
}

const DEAD_ITEM = ['cancelled', 'refunded'];

@Injectable()
export class DigitalAccessService implements OnModuleInit {
  private readonly logger = new Logger(DigitalAccessService.name);
  private pending = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    @InjectModel(DigitalAccess.name) readonly accessModel: Model<DigitalAccessDocument>,
    @InjectModel(DeliveryLog.name) readonly logModel: Model<DeliveryDocument>,
    @Optional() private readonly mailer?: DigitalMailerService,
  ) {}

  onModuleInit() {
    orderEvents.on(ORDER_CHANGED, (id: string) => this.queueOrder(id));
    orderEvents.on(ORDER_DISPUTED, (ids: string[]) => {
      this.revokeDisputed(ids).catch((e) => this.logger.warn(`chargeback revoke failed: ${e?.message}`));
    });
  }

  /** Several writes to one order in a row (very common) are handled once. */
  private queueOrder(orderId: string) {
    if (this.pending.has(orderId)) return;
    this.pending.add(orderId);
    setTimeout(() => {
      this.pending.delete(orderId);
      this.onOrderChanged(orderId).catch((e) => this.logger.warn(`digital sync of order ${orderId} failed: ${e?.message}`));
    }, 250);
  }

  /**
   * Event-driven grant / revoke. Paid order => grant (idempotent, mails once); cancelled / refunded item =>
   * its access is revoked. Reconcile on read stays as the safety net for anything this misses.
   */
  async onOrderChanged(orderId: string): Promise<void> {
    const order: any = await this.db.repositories.orderModel.findOne({ _id: orderId, isDelete: false }).lean();
    if (!order) return;
    const hasDigital = (order.sellerOrders ?? []).some((so: any) => (so.items ?? []).some((i: any) => i.type === 'digital'));
    if (!hasDigital) return;
    for (const storeId of new Set<string>((order.sellerOrders ?? []).map((so: any) => String(so.storeId)))) {
      await this.grantForOrder(order, storeId);
    }
    await this.reconcileOrder(orderId);
  }

  /** Chargeback: withdraw every access created by these orders (the seller can grant it again if the dispute is won). */
  async revokeDisputed(orderIds: string[]): Promise<number> {
    let n = 0;
    for (const id of orderIds) {
      const order: any = await this.db.repositories.orderModel.findOne({ _id: id }).select('sellerOrders.storeId').lean();
      for (const storeId of new Set<string>((order?.sellerOrders ?? []).map((s: any) => String(s.storeId)))) n += await this.revokeForOrder(storeId, id, 'chargeback');
    }
    return n;
  }

  /** Revoke the access of every item of this order that was cancelled or refunded. */
  async reconcileOrder(orderId: string): Promise<number> {
    const rows = await this.accessModel.find({ sourceOrderId: orderId, status: 'active' });
    let revoked = 0;
    for (const r of rows) {
      const fresh = await this.reconcile(r);
      if (fresh.status === 'revoked') revoked++;
    }
    return revoked;
  }

  /** Mail every customer who currently has active access to this product about a new file version. */
  async notifyFileUpdated(storeId: string, productId: string, v: { productName: string; fileName: string; version: string; changelog: string | null }): Promise<number> {
    if (!this.mailer) return 0;
    const rows = await this.accessModel.find({ storeId, resourceKind: 'file', resourceRef: productId, status: 'active' }).select('customerId').limit(5000).lean();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.customerId)) continue;
      seen.add(r.customerId);
      void this.mailer.fileUpdated(storeId, r.customerId, v);
    }
    return seen.size;
  }

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
        if (res.upsertedCount) {
          granted++;
          void this.mailer?.purchaseDelivered(storeId, order.userId, (await productModel.findOne({ _id: item.productId, storeId }).select('name').lean() as any)?.name ?? 'your purchase');
        }
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

  /** 30-day digital sales + delivery counters + what needs the seller's attention. */
  async stats(storeId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [orders, ok, denied, flagged] = await Promise.all([
      this.db.repositories.orderModel.find({ isPaid: true, isDelete: false, createdAt: { $gte: since }, 'sellerOrders.storeId': storeId }).select('sellerOrders').limit(5000).lean(),
      this.logModel.countDocuments({ storeId, outcome: 'ok', at: { $gte: since } }),
      this.logModel.countDocuments({ storeId, outcome: { $ne: 'ok' }, at: { $gte: since } }),
      this.accessModel.countDocuments({ storeId, flagged: true, status: 'active' }),
    ]);
    let revenue = 0;
    let items = 0;
    for (const o of orders as any[]) for (const so of o.sellerOrders ?? []) if (so.storeId === storeId) for (const it of so.items ?? []) {
      if (it.type === 'digital' && !['cancelled', 'refunded'].includes(it.status)) { revenue += Number(it.totalPrice) || 0; items++; }
    }
    return { last30Days: { digitalRevenue: Math.round(revenue * 100) / 100, digitalItemsSold: items, deliveries: ok, deniedOrFailed: denied }, flaggedAccess: flagged };
  }

  /** Reports: top downloaded products and a per-day delivery count for the last 30 days. */
  async reports(storeId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [top, perDay] = await Promise.all([
      this.logModel.aggregate([
        { $match: { storeId, outcome: 'ok', at: { $gte: since }, productId: { $ne: null } } },
        { $group: { _id: '$productId', deliveries: { $sum: 1 }, customers: { $addToSet: '$customerId' } } },
        { $project: { deliveries: 1, customers: { $size: '$customers' } } },
        { $sort: { deliveries: -1 } }, { $limit: 20 },
      ]),
      this.logModel.aggregate([
        { $match: { storeId, at: { $gte: since } } },
        { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$at' } }, outcome: '$outcome' }, n: { $sum: 1 } } },
        { $sort: { '_id.day': 1 } },
      ]),
    ]);
    const products: any[] = await this.db.repositories.productModel.find({ _id: { $in: top.map((t: any) => t._id) }, storeId }).select('name').lean();
    const name = new Map(products.map((p) => [String(p._id), p.name]));
    return {
      topProducts: top.map((t: any) => ({ productId: t._id, name: name.get(String(t._id)) ?? 'Deleted product', deliveries: t.deliveries, customers: t.customers })),
      perDay: perDay.map((d: any) => ({ day: d._id.day, outcome: d._id.outcome, count: d.n })),
    };
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
