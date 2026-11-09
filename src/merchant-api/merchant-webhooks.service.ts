/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { promises as dns } from 'dns';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { ORDER_CHANGED, orderEvents } from '../common/order-events';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { isPrivateIp } from '../messaging-channels/sms.util';
import { WebhookDelivery, WebhookDeliveryDocument, WebhookSubscription, WebhookSubscriptionDocument } from './merchant-api.schema';
import { AUTO_DISABLE_AFTER, WEBHOOK_EVENTS, nextDelayMs, newSecret, signPayload, validEvents, validateWebhookUrl, type WebhookEvent } from './merchant-api.util';

const MAX_SUBSCRIPTIONS = 10;
const hint = (s: string) => `…${s.slice(-4)}`;

@Injectable()
export class MerchantWebhooksService implements OnModuleInit {
  private readonly log = new Logger(MerchantWebhooksService.name);
  constructor(
    @InjectModel(WebhookSubscription.name) private readonly subs: Model<WebhookSubscriptionDocument>,
    @InjectModel(WebhookDelivery.name) private readonly deliveries: Model<WebhookDeliveryDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  onModuleInit() { orderEvents.on(ORDER_CHANGED, (id: string) => { void this.fromOrder(id).catch((e) => this.log.warn(`order webhook: ${e?.message}`)); }); }

  private audit(storeId: string, actor: { id: string; role: string }, action: string, description: string, targetId: string) {
    return this.activity.log({ storeId, category: 'webhooks', action, description, actorId: actor.id, actorRole: actor.role, targetId, targetType: 'webhook' } as any).catch(() => undefined);
  }

  async list(storeId: string) { return { events: WEBHOOK_EVENTS, items: await this.subs.find({ storeId }).sort({ createdAt: -1 }).lean() }; }

  async create(storeId: string, actor: { id: string; role: string }, body: any) {
    const err = validateWebhookUrl(body?.url); if (err) throw new BadRequestException(err);
    const events = validEvents(body?.events); if (!events) throw new BadRequestException('Choose at least one valid event');
    if ((await this.subs.countDocuments({ storeId })) >= MAX_SUBSCRIPTIONS) throw new BadRequestException(`At most ${MAX_SUBSCRIPTIONS} webhooks per store`);
    const secret = newSecret();
    const doc = await this.subs.create({ storeId, url: String(body.url).trim(), events, secretEnc: encryptCredential(secret, 'INTEGRATIONS'), secretHint: hint(secret), description: typeof body?.description === 'string' ? body.description.slice(0, 120) : '' });
    void this.audit(storeId, actor, 'webhook_created', `Webhook created for ${events.join(', ')}`, String(doc._id));
    return { id: String(doc._id), secret };
  }

  async update(storeId: string, actor: { id: string; role: string }, id: string, body: any) {
    const set: any = {};
    if (body?.url !== undefined) { const e = validateWebhookUrl(body.url); if (e) throw new BadRequestException(e); set.url = String(body.url).trim(); }
    if (body?.events !== undefined) { const ev = validEvents(body.events); if (!ev) throw new BadRequestException('Choose at least one valid event'); set.events = ev; }
    if (typeof body?.enabled === 'boolean') { set.enabled = body.enabled; if (body.enabled) { set.consecutiveFailures = 0; set.disabledReason = null; } }
    const r = await this.subs.findOneAndUpdate({ _id: this.oid(id), storeId }, { $set: set }, { new: true }).lean();
    if (!r) throw new NotFoundException('Webhook not found');
    void this.audit(storeId, actor, 'webhook_updated', 'Webhook updated', id);
    return r;
  }

  async rotate(storeId: string, actor: { id: string; role: string }, id: string) {
    const secret = newSecret();
    const r = await this.subs.findOneAndUpdate({ _id: this.oid(id), storeId }, { $set: { secretEnc: encryptCredential(secret, 'INTEGRATIONS'), secretHint: hint(secret) } }, { new: true }).lean();
    if (!r) throw new NotFoundException('Webhook not found');
    void this.audit(storeId, actor, 'webhook_secret_rotated', 'Webhook secret rotated', id);
    return { secret };
  }

  async remove(storeId: string, actor: { id: string; role: string }, id: string) {
    const r = await this.subs.deleteOne({ _id: this.oid(id), storeId });
    if (!r.deletedCount) throw new NotFoundException('Webhook not found');
    void this.audit(storeId, actor, 'webhook_deleted', 'Webhook deleted', id);
    return { success: true };
  }

  async deliveryLog(storeId: string, id: string, q: { page?: any; limit?: any }) {
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const f = { storeId, subscriptionId: id };
    const [items, total] = await Promise.all([this.deliveries.find(f).select('-payload').sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.deliveries.countDocuments(f)]);
    return { items, total, page, limit };
  }

  /** Puts a finished delivery back in the queue (same event id). */
  async redeliver(storeId: string, actor: { id: string; role: string }, deliveryId: string) {
    const d = await this.deliveries.findOneAndUpdate({ _id: this.oid(deliveryId), storeId, status: { $in: ['failed', 'success'] }, inFlight: false }, { $set: { status: 'pending', nextAttemptAt: new Date(), attempts: 0, error: null } }, { new: true }).lean();
    if (!d) throw new NotFoundException('Delivery not found or still being sent');
    void this.audit(storeId, actor, 'webhook_redelivered', `Redelivery of ${d.event}`, String(d.subscriptionId));
    setImmediate(() => void this.attempt(String(d._id)));
    return { success: true };
  }

  private oid(id: string) { if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Not found'); return new Types.ObjectId(id); }

  /** Queues one delivery per matching subscription. `eventKey` makes it happen at most once per subscription. */
  async emit(storeId: string, event: WebhookEvent, data: Record<string, unknown>, eventKey: string) {
    const subs: any[] = await this.subs.find({ storeId, enabled: true, events: event }).select('_id').lean();
    for (const s of subs) {
      const eventId = eventKey;
      const payload = JSON.stringify({ id: eventId, event, created_at: new Date().toISOString(), store_id: storeId, data });
      try {
        const d = await this.deliveries.create({ storeId, subscriptionId: String(s._id), event, eventId, payload, nextAttemptAt: new Date() });
        setImmediate(() => void this.attempt(String(d._id)));
      } catch (e: any) { if (e?.code !== 11000) throw e; }
    }
  }

  async fromOrder(orderId: string) {
    const o: any = await (this.db.repositories as any).orderModel.findById(orderId).select('isPaid orderStatus orderNumber totalAmount currency createdAt sellerOrders.storeId').lean();
    if (!o) return;
    const stores = [...new Set((o.sellerOrders ?? []).map((s: any) => String(s.storeId)))] as string[];
    const data = { order_id: String(orderId), order_number: o.orderNumber ?? null, status: o.orderStatus, paid: !!o.isPaid, total: o.totalAmount, currency: o.currency };
    const events: WebhookEvent[] = [];
    if (o.createdAt && Date.now() - new Date(o.createdAt).getTime() < 10 * 60_000) events.push('order.created');
    if (o.isPaid) events.push('order.paid');
    if (['shipped', 'delivered', 'completed'].includes(o.orderStatus)) events.push('order.fulfilled');
    if (o.orderStatus === 'cancelled') events.push('order.cancelled');
    if (o.orderStatus === 'refunded') events.push('refund.created');
    for (const s of stores) for (const e of events) await this.emit(s, e, data, `${e}:${orderId}`);
  }

  private async assertPublic(url: string) {
    const host = new URL(url).hostname;
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('The address resolves to a private network');
  }

  /** One delivery attempt, claimed so two workers never send the same one. */
  async attempt(deliveryId: string) {
    const d: any = await this.deliveries.findOneAndUpdate({ _id: deliveryId, status: 'pending', inFlight: false }, { $set: { inFlight: true, lastAttemptAt: new Date() }, $inc: { attempts: 1 } }, { new: true }).lean();
    if (!d) return;
    let ok = false; let status: number | null = null; let error: string | null = null;
    try {
      const sub: any = await this.subs.findOne({ _id: d.subscriptionId, storeId: d.storeId }).select('+secretEnc url enabled').lean();
      if (!sub || !sub.enabled) throw new Error('Webhook is switched off or deleted');
      const err = validateWebhookUrl(sub.url); if (err) throw new Error(err);
      await this.assertPublic(sub.url);
      const res = await fetch(sub.url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Solvexo-Webhooks/1.0', 'X-Solvexo-Event': d.event, 'X-Solvexo-Delivery': d.eventId, 'X-Solvexo-Signature': signPayload(decryptCredential(sub.secretEnc, 'INTEGRATIONS'), d.payload) },
        body: d.payload,
      });
      status = res.status; ok = res.status >= 200 && res.status < 300;
      if (!ok) error = `The receiver answered HTTP ${res.status}`;
    } catch (e: any) { error = String(e?.message ?? e).slice(0, 200); }
    if (ok) {
      await this.deliveries.updateOne({ _id: d._id }, { $set: { status: 'success', inFlight: false, responseStatus: status, error: null, nextAttemptAt: null } });
      await this.subs.updateOne({ _id: d.subscriptionId }, { $set: { consecutiveFailures: 0 } });
      return;
    }
    const delay = nextDelayMs(d.attempts);
    if (delay !== null) { await this.deliveries.updateOne({ _id: d._id }, { $set: { inFlight: false, responseStatus: status, error, nextAttemptAt: new Date(Date.now() + delay) } }); return; }
    await this.deliveries.updateOne({ _id: d._id }, { $set: { status: 'failed', inFlight: false, responseStatus: status, error, nextAttemptAt: null } });
    const sub: any = await this.subs.findOneAndUpdate({ _id: d.subscriptionId }, { $inc: { consecutiveFailures: 1 } }, { new: true }).lean();
    if (sub && sub.enabled && sub.consecutiveFailures >= AUTO_DISABLE_AFTER) {
      await this.subs.updateOne({ _id: d.subscriptionId, enabled: true }, { $set: { enabled: false, disabledReason: `Switched off after ${AUTO_DISABLE_AFTER} failed deliveries in a row` } });
      void this.audit(d.storeId, { id: 'system', role: 'system' }, 'webhook_auto_disabled', 'Webhook switched off after repeated failures', String(d.subscriptionId));
    }
  }

  async runDue(now = new Date()) {
    await this.deliveries.updateMany({ inFlight: true, lastAttemptAt: { $lt: new Date(now.getTime() - 5 * 60_000) } }, { $set: { inFlight: false } });
    const due: any[] = await this.deliveries.find({ status: 'pending', inFlight: false, nextAttemptAt: { $lte: now } }).select('_id').limit(50).lean();
    for (const d of due) await this.attempt(String(d._id));
    return due.length;
  }

  @Cron('* * * * *')
  async cron() { if (this.redis) await this.redis.withLock('cron-lock:merchant-webhooks', 55_000, async () => { await this.runDue(); }); }
}
