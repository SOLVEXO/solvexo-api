/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { ORDER_CHANGED, orderEvents } from '../common/order-events';
import { pageOf } from '../common/paging';
import { DatabaseService } from '../database/databaseservice';
import { newSecret, validateWebhookUrl, verifySignature } from '../merchant-api/merchant-api.util';
import { OrdersService } from '../orders/orders.service';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { FulfillmentRequest, FulfillmentRequestDocument, FulfillmentService, FulfillmentServiceDocument, REQUEST_STATUSES } from './fulfillment.schema';
import { addressPayload, nextStatus, parseCallback, providerFor, type FulfillmentPayload } from './fulfillment.util';

export const FULFILLMENT_SEND_JOB = 'send-fulfillment-request';
export const MAX_SERVICES_PER_STORE = 5;
export const MAX_SEND_ATTEMPTS = 4;
type Actor = { id: string; role: string };
const isOid = (v: unknown) => typeof v === 'string' && Types.ObjectId.isValid(v);
const hint = (s: string) => `...${s.slice(-4)}`;

@Injectable()
export class FulfillmentServicesService implements OnModuleInit {
  private readonly log = new Logger('Fulfillment');
  constructor(
    @InjectModel(FulfillmentService.name) private readonly services: Model<FulfillmentServiceDocument>,
    @InjectModel(FulfillmentRequest.name) private readonly requests: Model<FulfillmentRequestDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly moduleRef: ModuleRef,
    @Optional() @InjectQueue(QUEUE_NAMES.FULFILLMENT_SEND) private readonly queue?: Queue,
  ) {}

  onModuleInit() {
    // Auto-routing: every write that may have made an order paid is checked; routing is idempotent (unique index).
    orderEvents.on(ORDER_CHANGED, (id: string) => { void this.autoRoute(String(id)).catch((e) => this.log.warn(`auto-route ${id}: ${e?.message}`)); });
  }

  private audit(storeId: string, actor: Actor, action: string, description: string, targetId?: string, targetType?: string) {
    return this.activity.log({ storeId, category: 'fulfillment', action, description, actorId: actor.id, actorRole: actor.role, targetId: targetId ?? '', targetType } as any).catch(() => undefined);
  }

  // ── services ──────────────────────────────────────────────────────────────
  listServices(storeId: string) { return this.services.find({ storeId, isDelete: false }).sort({ name: 1 }).lean(); }

  async createService(storeId: string, sellerId: string, actor: Actor, body: any) {
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) throw new BadRequestException('Name is required');
    const provider = body?.provider === 'mock' ? 'mock' : body?.provider === 'generic_http' ? 'generic_http' : null;
    if (!provider) throw new BadRequestException('Unknown provider');
    let endpointUrl: string | null = null;
    if (provider === 'generic_http') {
      const err = validateWebhookUrl(body?.endpointUrl); if (err) throw new BadRequestException(err);
      endpointUrl = String(body.endpointUrl).trim();
    }
    if ((await this.services.countDocuments({ storeId, isDelete: false })) >= MAX_SERVICES_PER_STORE) throw new BadRequestException(`At most ${MAX_SERVICES_PER_STORE} fulfilment services per store`);
    const secret = newSecret();
    let doc: any;
    try {
      doc = await this.services.create({ storeId, name, provider, endpointUrl, secretEnc: encryptCredential(secret, 'INTEGRATIONS'), secretHint: hint(secret), autoRoute: body?.autoRoute === true, trackInventory: body?.trackInventory !== false });
    } catch (e: any) { if (e?.code === 11000) throw new ConflictException('A service with this name already exists'); throw e; }
    // The service owns a warehouse location; stock it reports lands there.
    const loc: any = await this.db.repositories.storeLocationModel.create({ storeId, sellerId, name: `${name} (fulfilment)`, type: 'warehouse', fulfillmentServiceId: String(doc._id) } as any);
    await this.services.updateOne({ _id: doc._id }, { $set: { locationId: String(loc._id) } });
    await this.audit(storeId, actor, 'fulfillment_service_connected', `Fulfilment service "${name}" connected`, String(doc._id), 'fulfillment_service');
    return { ...doc.toObject(), secretEnc: undefined, locationId: String(loc._id), secret };
  }

  async updateService(storeId: string, actor: Actor, id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Service not found');
    const set: any = {};
    if (typeof body?.name === 'string') { const n = body.name.trim().slice(0, 80); if (!n) throw new BadRequestException('Name is required'); set.name = n; }
    if (body?.endpointUrl !== undefined) { const err = validateWebhookUrl(body.endpointUrl); if (err) throw new BadRequestException(err); set.endpointUrl = String(body.endpointUrl).trim(); }
    if (body?.status !== undefined) { if (!['active', 'disabled'].includes(body.status)) throw new BadRequestException('Unknown status'); set.status = body.status; }
    if (body?.autoRoute !== undefined) set.autoRoute = body.autoRoute === true;
    if (body?.trackInventory !== undefined) set.trackInventory = body.trackInventory === true;
    let s: any;
    try { s = await this.services.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: set }, { new: true }).lean(); }
    catch (e: any) { if (e?.code === 11000) throw new ConflictException('A service with this name already exists'); throw e; }
    if (!s) throw new NotFoundException('Service not found');
    await this.audit(storeId, actor, 'fulfillment_service_updated', `Fulfilment service "${s.name}" updated`, id, 'fulfillment_service');
    return s;
  }

  async rotateSecret(storeId: string, actor: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('Service not found');
    const secret = newSecret();
    const s: any = await this.services.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: { secretEnc: encryptCredential(secret, 'INTEGRATIONS'), secretHint: hint(secret) } }, { new: true }).lean();
    if (!s) throw new NotFoundException('Service not found');
    await this.audit(storeId, actor, 'fulfillment_secret_rotated', `Secret of "${s.name}" rotated`, id, 'fulfillment_service');
    return { secret, secretHint: s.secretHint };
  }

  async deleteService(storeId: string, actor: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('Service not found');
    if (await this.requests.exists({ storeId, serviceId: id, status: { $in: ['pending', 'sent', 'accepted'] } })) throw new ConflictException('This service still has open requests. Wait for them or cancel them first.');
    const s: any = await this.services.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: { isDelete: true, status: 'disabled' } }).lean();
    if (!s) throw new NotFoundException('Service not found');
    await this.audit(storeId, actor, 'fulfillment_service_removed', `Fulfilment service "${s.name}" removed`, id, 'fulfillment_service');
    return { success: true };
  }

  // ── requests ──────────────────────────────────────────────────────────────
  async listRequests(storeId: string, q: any) {
    const filter: any = { storeId };
    if (typeof q?.status === 'string' && (REQUEST_STATUSES as readonly string[]).includes(q.status)) filter.status = q.status;
    if (typeof q?.serviceId === 'string' && isOid(q.serviceId)) filter.serviceId = q.serviceId;
    const { page, limit, skip } = pageOf(q?.page, q?.limit);
    const [items, total] = await Promise.all([this.requests.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), this.requests.countDocuments(filter)]);
    return { items, total, page, limit };
  }

  /** Builds the request from the order's physical, not-yet-shipped lines of THIS store. */
  private buildItems(order: any, storeId: string) {
    const so = (order.sellerOrders ?? []).find((s: any) => String(s.storeId) === String(storeId));
    if (!so || so.fulfillmentType === 'digital' || ['cancelled', 'refunded'].includes(so.status)) return null;
    const shipped = new Map<string, number>();
    for (const sh of so.shipments ?? []) for (const it of sh.items ?? []) shipped.set(String(it.itemId), (shipped.get(String(it.itemId)) ?? 0) + it.quantity);
    const items = (so.items ?? [])
      .filter((i: any) => i.type !== 'digital' && !['cancelled', 'refunded'].includes(i.status))
      .map((i: any) => ({ itemId: String(i._id), variantId: i.variantId ?? null, sku: i.sku ?? null, title: String(i.name ?? i.title ?? '').slice(0, 200), quantity: i.quantity - (shipped.get(String(i._id)) ?? 0) }))
      .filter((i: any) => i.quantity > 0);
    return items.length ? items : null;
  }

  async createRequest(storeId: string, actor: Actor, orderId: string, serviceId: string, auto = false) {
    if (!isOid(orderId) || !isOid(serviceId)) throw new NotFoundException('Order or service not found');
    const svc: any = await this.services.findOne({ _id: serviceId, storeId, isDelete: false }).lean();
    if (!svc) throw new NotFoundException('Service not found');
    if (svc.status !== 'active') throw new BadRequestException('This service is switched off');
    const order: any = await this.db.repositories.orderModel.findOne({ _id: orderId, isDelete: false }).lean();
    if (!order || !(order.sellerOrders ?? []).some((s: any) => String(s.storeId) === String(storeId))) throw new NotFoundException('Order not found');
    const items = this.buildItems(order, storeId);
    if (!items) throw new BadRequestException('Nothing left to fulfil on this order');
    let doc: any;
    try { doc = await this.requests.create({ storeId, serviceId, orderId, orderNumber: String(order.orderNumber ?? ''), items }); }
    catch (e: any) { if (e?.code === 11000) throw new ConflictException('This order was already sent to this service'); throw e; }
    await this.audit(storeId, actor, auto ? 'fulfillment_auto_routed' : 'fulfillment_request_created', `Order #${order.orderNumber} sent to "${svc.name}"`, String(doc._id), 'fulfillment_request');
    await this.enqueue(String(doc._id));
    return doc.toObject();
  }

  async enqueue(requestId: string) {
    if (!this.queue) return;
    await this.queue.add(FULFILLMENT_SEND_JOB, { requestId }, { attempts: MAX_SEND_ATTEMPTS, backoff: { type: 'exponential', delay: 60_000 }, jobId: `ffr-${requestId}-${Date.now()}` });
  }

  /** Queue worker entry (also called directly by tests). Throws before the last attempt so BullMQ retries. */
  async processSend(requestId: string, lastAttempt: boolean) {
    if (!isOid(requestId)) return;
    const req: any = await this.requests.findOneAndUpdate({ _id: requestId, status: 'pending' }, { $inc: { attempts: 1 } }, { new: true }).lean();
    if (!req) return; // already sent / cancelled / redelivered job
    const svc: any = await this.services.findOne({ _id: req.serviceId, storeId: req.storeId, isDelete: false }).select('+secretEnc provider endpointUrl status').lean();
    try {
      if (!svc || svc.status !== 'active') throw new Error('Service is switched off or removed');
      const order: any = await this.db.repositories.orderModel.findOne({ _id: req.orderId }).select('shippingAddress sellerOrders orderNumber').lean();
      const payload: FulfillmentPayload = {
        event: 'fulfillment_request', requestId: String(req._id), orderNumber: req.orderNumber,
        items: req.items.map((i: any) => ({ itemId: i.itemId, sku: i.sku, title: i.title, quantity: i.quantity })),
        shippingAddress: addressPayload(order?.shippingAddress), shippingMethod: order ? this.shippingMethodOf(order, req.storeId) : null,
      };
      const { externalId } = await providerFor(svc.provider).send({ endpointUrl: svc.endpointUrl, secret: decryptCredential(svc.secretEnc, 'INTEGRATIONS'), requestId: String(req._id) }, payload);
      await this.requests.updateOne({ _id: req._id, status: 'pending' }, { $set: { status: 'sent', externalId, sentAt: new Date(), lastError: null } });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      if (lastAttempt) {
        await this.requests.updateOne({ _id: req._id, status: 'pending' }, { $set: { status: 'failed', lastError: msg } });
        return;
      }
      await this.requests.updateOne({ _id: req._id }, { $set: { lastError: msg } });
      throw e;
    }
  }

  private shippingMethodOf(order: any, storeId: string): string | null {
    const so = (order.sellerOrders ?? []).find((s: any) => String(s.storeId) === String(storeId));
    return typeof so?.shippingMethod === 'string' ? so.shippingMethod.slice(0, 80) : typeof order.shippingMethod === 'string' ? order.shippingMethod.slice(0, 80) : null;
  }

  async retry(storeId: string, actor: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('Request not found');
    const r: any = await this.requests.findOneAndUpdate({ _id: id, storeId, status: 'failed' }, { $set: { status: 'pending', attempts: 0, lastError: null } }, { new: true }).lean();
    if (!r) throw new ConflictException('Only failed requests can be retried');
    await this.audit(storeId, actor, 'fulfillment_request_retried', `Request for order #${r.orderNumber} retried`, id, 'fulfillment_request');
    await this.enqueue(id);
    return r;
  }

  async cancelRequest(storeId: string, actor: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('Request not found');
    const r: any = await this.requests.findOneAndUpdate({ _id: id, storeId, status: { $in: ['pending', 'sent', 'accepted'] } }, { $set: { status: 'cancelled' } }, { new: true }).lean();
    if (!r) throw new ConflictException('This request can no longer be cancelled');
    await this.audit(storeId, actor, 'fulfillment_request_cancelled', `Request for order #${r.orderNumber} cancelled`, id, 'fulfillment_request');
    return r;
  }

  /** A paid order is handed to every active auto-route service of its store (once; the unique index makes repeats a no-op). */
  async autoRoute(orderId: string) {
    if (!isOid(orderId)) return;
    const order: any = await this.db.repositories.orderModel.findOne({ _id: orderId, isDelete: false }).select('isPaid sellerOrders').lean();
    if (!order?.isPaid) return;
    for (const so of order.sellerOrders ?? []) {
      const storeId = String(so.storeId);
      const svc: any = await this.services.findOne({ storeId, status: 'active', autoRoute: true, isDelete: false }).sort({ createdAt: 1 }).lean();
      if (!svc) continue;
      if (await this.requests.exists({ storeId, orderId })) continue; // already routed (to any service)
      try { await this.createRequest(storeId, { id: 'system', role: 'system' }, orderId, String(svc._id), true); }
      catch (e: any) { if (!(e instanceof ConflictException) && !(e instanceof BadRequestException)) throw e; }
    }
  }

  // ── inbound callbacks ─────────────────────────────────────────────────────
  async handleCallback(serviceId: string, rawBody: string, signature: string, body: any) {
    if (!isOid(serviceId)) throw new UnauthorizedException('Invalid signature');
    const svc: any = await this.services.findOne({ _id: serviceId, isDelete: false }).select('+secretEnc storeId status trackInventory locationId name').lean();
    // Same answer for unknown service and bad signature (no probing).
    if (!svc || svc.status !== 'active' || !signature || !verifySignature(decryptCredential(svc.secretEnc, 'INTEGRATIONS'), rawBody, signature)) throw new UnauthorizedException('Invalid signature');
    const ev = parseCallback(body);
    if (!ev.ok) throw new BadRequestException(ev.error);
    await this.services.updateOne({ _id: svc._id }, { $set: { lastCallbackAt: new Date() } });
    if (ev.type === 'stock') return this.syncStock(svc, ev.stock);
    if (!isOid(ev.requestId ?? '')) throw new NotFoundException('Request not found');
    const cur: any = await this.requests.findOne({ _id: ev.requestId, serviceId, storeId: svc.storeId }).lean();
    if (!cur) throw new NotFoundException('Request not found');
    if ((cur.eventIds ?? []).includes(ev.eventId)) return { success: true, duplicate: true };
    const target = nextStatus(cur.status, ev.type);
    if (!target) {
      await this.requests.updateOne({ _id: cur._id }, { $addToSet: { eventIds: ev.eventId } });
      return { success: true, ignored: true };
    }
    // Claim: only the first delivery of this event, from the status we read, moves the request.
    const set: any = { status: target, lastError: null };
    if (ev.tracking) set.tracking = ev.tracking;
    const claimed: any = await this.requests.findOneAndUpdate({ _id: cur._id, status: cur.status, eventIds: { $ne: ev.eventId } }, { $set: set, $push: { eventIds: ev.eventId } }, { new: true }).lean();
    if (!claimed) return { success: true, duplicate: true };
    if (target === 'shipped') {
      try { await this.applyShipment(claimed); }
      catch (e: any) {
        // Undo the claim so the service's retry of the same event is processed again.
        await this.requests.updateOne({ _id: cur._id }, { $set: { status: cur.status, lastError: String(e?.message ?? e).slice(0, 300) }, $pull: { eventIds: ev.eventId } });
        throw e;
      }
    }
    await this.audit(svc.storeId, { id: String(svc._id), role: 'fulfillment_service' }, `fulfillment_${target}`, `"${svc.name}" reported ${target} for order #${claimed.orderNumber}`, String(claimed._id), 'fulfillment_request');
    return { success: true };
  }

  /** Marks the shipped lines fulfilled through the normal fulfil path (tracking, buyer email, stock rules all unchanged). */
  private async applyShipment(req: any) {
    const store: any = await this.db.repositories.storeModel.findById(req.storeId).select('sellerId').lean();
    if (!store) throw new Error('Store not found');
    const svc = this.moduleRef.get(OrdersService, { strict: false });
    await svc.fulfilItems(String(store.sellerId), req.storeId, req.orderId, {
      items: req.items.map((i: any) => ({ itemId: i.itemId, quantity: i.quantity })),
      carrier: req.tracking?.carrier ?? undefined, trackingNumber: req.tracking?.trackingNumber ?? undefined, trackingUrl: req.tracking?.trackingUrl ?? undefined, notifyCustomer: true,
    });
  }

  /** Stock levels the service reports -> the location it owns. Unknown SKUs are skipped and counted. */
  async syncStock(svc: any, rows: { sku: string; quantity: number }[]) {
    if (!svc.trackInventory || !svc.locationId) return { success: true, updated: 0, skipped: rows.length };
    const { productVariantModel, variantLocationStockModel } = this.db.repositories as any;
    let updated = 0; let skipped = 0;
    for (const r of rows) {
      const v: any = await productVariantModel.findOne({ storeId: svc.storeId, sku: r.sku, isDelete: false }).select('_id productId').lean();
      if (!v) { skipped++; continue; }
      const old: any = await variantLocationStockModel.findOneAndUpdate(
        { storeId: svc.storeId, variantId: String(v._id), locationId: svc.locationId, binId: null },
        { $set: { stock: r.quantity }, $setOnInsert: { productId: String(v.productId) } },
        { upsert: true, new: false },
      ).select('stock').lean();
      const delta = r.quantity - (old?.stock ?? 0);
      if (delta !== 0) await productVariantModel.updateOne({ _id: v._id, storeId: svc.storeId }, { $inc: { stock: delta } });
      updated++;
    }
    return { success: true, updated, skipped };
  }
}
