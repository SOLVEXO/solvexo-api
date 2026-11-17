/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DraftOrdersService } from '../draft-orders/draft-orders.service';
import { DatabaseService } from '../database/databaseservice';
import { storePublicUrl } from '../newsletter/marketing-email.util';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../redis/redis.service';
import { CONTRACT_STATUSES, SellingPlanGroup, SellingPlanGroupDocument, SubscriptionContract, SubscriptionContractDocument, SubscriptionCycle, SubscriptionCycleDocument } from './selling-plan.schema';
import { MAX_QTY, PAUSE_AFTER_DAYS, REMINDER_DAYS, STOCK_FAILURES_BEFORE_PAUSE, addInterval, cleanAddress, discountedPrice, eligible, monthlyFactor, round2, validateGroup } from './selling-plan.util';

type Actor = { id: string; role: string };
const isOid = (v: unknown) => typeof v === 'string' && Types.ObjectId.isValid(v);
const DAY = 86_400_000;
const MAX_CONTRACTS_PER_BUYER = 20;

@Injectable()
export class SellingPlansService {
  private readonly log = new Logger('SellingPlans');
  constructor(
    @InjectModel(SellingPlanGroup.name) private readonly groups: Model<SellingPlanGroupDocument>,
    @InjectModel(SubscriptionContract.name) private readonly contracts: Model<SubscriptionContractDocument>,
    @InjectModel(SubscriptionCycle.name) private readonly cycles: Model<SubscriptionCycleDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private audit(storeId: string, actor: Actor, action: string, description: string, targetId?: string, targetType?: string) {
    return this.activity.log({ storeId, category: 'subscriptions', action, description, actorId: actor.id, actorRole: actor.role, targetId: targetId ?? '', targetType } as any).catch(() => undefined);
  }

  // ── plan groups (seller) ──────────────────────────────────────────────────
  listGroups(storeId: string) { return this.groups.find({ storeId }).sort({ status: 1, name: 1 }).lean(); }

  private async assertProducts(storeId: string, productIds: string[]) {
    if (!productIds.length) return;
    const n = await (this.db.repositories.productModel as any).countDocuments({ _id: { $in: productIds }, storeId, isDelete: false });
    if (n !== productIds.length) throw new BadRequestException('One or more products do not belong to this store');
  }

  async createGroup(storeId: string, actor: Actor, body: any) {
    const v = validateGroup(body, false); if (!v.ok) throw new BadRequestException(v.error);
    await this.assertProducts(storeId, v.data.productIds ?? []);
    try {
      const g = await this.groups.create({ ...v.data, storeId });
      await this.audit(storeId, actor, 'selling_plan_created', `Subscription plan "${g.name}" created`, String(g._id), 'selling_plan');
      return g.toObject();
    } catch (e: any) { if (e?.code === 11000) throw new ConflictException('A plan with this name already exists'); throw e; }
  }

  async updateGroup(storeId: string, actor: Actor, id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Plan not found');
    const v = validateGroup(body, true); if (!v.ok) throw new BadRequestException(v.error);
    if (v.data.productIds) await this.assertProducts(storeId, v.data.productIds);
    let g: any;
    try { g = await this.groups.findOneAndUpdate({ _id: id, storeId }, { $set: v.data }, { new: true }).lean(); }
    catch (e: any) { if (e?.code === 11000) throw new ConflictException('A plan with this name already exists'); throw e; }
    if (!g) throw new NotFoundException('Plan not found');
    await this.audit(storeId, actor, 'selling_plan_updated', `Subscription plan "${g.name}" updated`, id, 'selling_plan');
    return g;
  }

  // ── contracts (seller) ────────────────────────────────────────────────────
  async listContracts(storeId: string, q: any) {
    const filter: any = { storeId };
    if (typeof q?.status === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(q.status)) filter.status = q.status;
    const limit = Math.min(Math.max(parseInt(q?.limit, 10) || 20, 1), 100); const page = Math.max(parseInt(q?.page, 10) || 1, 1);
    const [items, total] = await Promise.all([this.contracts.find(filter).sort({ nextBillingAt: 1 }).skip((page - 1) * limit).limit(limit).lean(), this.contracts.countDocuments(filter)]);
    return { items, total, page, limit };
  }

  async upcoming(storeId: string, days = 14) {
    const until = new Date(Date.now() + Math.min(Math.max(days, 1), 60) * DAY);
    return this.contracts.find({ storeId, status: 'active', nextBillingAt: { $lte: until } }).sort({ nextBillingAt: 1 }).limit(100).lean();
  }

  /** Recurring-revenue style numbers in the store currency (estimate: current variant prices, weeks counted as 52/12 per month). */
  async report(storeId: string) {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('baseCurrency').lean();
    const [active, paused, cancelled30, total] = await Promise.all([
      this.contracts.find({ storeId, status: 'active' }).lean(),
      this.contracts.countDocuments({ storeId, status: 'paused' }),
      this.contracts.countDocuments({ storeId, status: 'cancelled', cancelledAt: { $gte: new Date(Date.now() - 30 * DAY) } }),
      this.contracts.countDocuments({ storeId }),
    ]);
    const variantIds = [...new Set(active.flatMap((c: any) => c.items.map((i: any) => i.variantId)))];
    const prices = new Map<string, number>((await (this.db.repositories.productVariantModel as any).find({ _id: { $in: variantIds }, storeId }).select('price').lean()).map((v: any) => [String(v._id), Number(v.price) || 0]));
    let mrr = 0;
    for (const c of active as any[]) {
      const goods = c.items.reduce((s: number, i: any) => s + discountedPrice(prices.get(i.variantId) ?? 0, c.terms.discountPercent) * i.quantity, 0);
      mrr += (goods + (c.terms.shippingAmount ?? 0)) * monthlyFactor(c.terms.unit, c.terms.count);
    }
    return { currency: store?.baseCurrency ?? 'USD', active: active.length, paused, cancelledLast30Days: cancelled30, total, monthlyRecurring: round2(mrr) };
  }

  async sellerAction(storeId: string, actor: Actor, id: string, action: string) {
    if (!isOid(id)) throw new NotFoundException('Subscription not found');
    const c = await this.apply({ _id: id, storeId }, action, actor.role === 'seller' || actor.role === 'staff' ? 'store' : 'system');
    await this.audit(storeId, actor, `subscription_${action}`, `Subscription ${action} (customer ${c.customerName})`, id, 'subscription');
    return c;
  }

  // ── storefront (buyer) ────────────────────────────────────────────────────
  /** Public: the plans a product can be bought on, with the price of the chosen variant under each frequency. */
  async plansFor(storeId: string, productId: string, variantId?: string) {
    if (!isOid(productId)) return [];
    const gs: any[] = await this.groups.find({ storeId, status: 'active', productIds: productId }).lean();
    let price: number | null = null;
    if (variantId && isOid(variantId)) {
      const v: any = await (this.db.repositories.productVariantModel as any).findOne({ _id: variantId, productId, storeId, isDelete: false }).select('price').lean();
      price = v ? Number(v.price) : null;
    }
    return gs.filter((g) => !variantId || eligible(g, productId, variantId)).map((g) => ({
      groupId: String(g._id), name: g.name, trialDays: g.trialDays, maxCycles: g.maxCycles, shippingAmount: g.shippingAmount,
      options: g.options.map((o: any) => ({ optionId: o.id, label: o.label, unit: o.unit, count: o.count, discountPercent: o.discountPercent, unitPrice: price == null ? null : discountedPrice(price, o.discountPercent) })),
    }));
  }

  async subscribe(storeId: string, userId: string, body: any) {
    const user: any = await (this.db.repositories.userModel as any).findOne({ _id: userId, storeId, isDelete: { $ne: true } }).select('name email contactEmail isGuest').lean();
    if (!user || user.isGuest) throw new BadRequestException('Sign in with a customer account to subscribe.');
    if (!isOid(body?.groupId) || !isOid(body?.variantId)) throw new BadRequestException('Invalid plan or product');
    const qty = Number(body?.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new BadRequestException(`Quantity must be a whole number 1-${MAX_QTY}`);
    const address = cleanAddress(body?.address); if (!address) throw new BadRequestException('A full delivery address is required');
    const g: any = await this.groups.findOne({ _id: body.groupId, storeId, status: 'active' }).lean();
    if (!g) throw new NotFoundException('This plan is not available');
    const opt = g.options.find((o: any) => o.id === body?.optionId); if (!opt) throw new BadRequestException('Choose a delivery frequency');
    const variant: any = await (this.db.repositories.productVariantModel as any).findOne({ _id: body.variantId, storeId, isDelete: false }).select('productId type').lean();
    const product: any = variant ? await (this.db.repositories.productModel as any).findOne({ _id: variant.productId, storeId, isDelete: false, status: 'active' }).select('_id').lean() : null;
    if (!variant || !product) throw new NotFoundException('Product not available');
    if (variant.type === 'digital') throw new BadRequestException('Digital products cannot be subscribed to');
    if (!eligible(g, String(variant.productId), String(variant._id))) throw new BadRequestException('This product is not part of that plan');
    if ((await this.contracts.countDocuments({ storeId, userId, status: { $in: ['active', 'paused'] } })) >= MAX_CONTRACTS_PER_BUYER) throw new BadRequestException('You have too many active subscriptions');
    const contract: any = await this.contracts.create({
      storeId, userId, groupId: String(g._id), optionId: opt.id,
      terms: { name: g.name, unit: opt.unit, count: opt.count, discountPercent: opt.discountPercent, shippingAmount: g.shippingAmount ?? 0, taxPercent: g.taxPercent ?? 0, maxCycles: g.maxCycles ?? null },
      items: [{ productId: String(variant.productId), variantId: String(variant._id), quantity: qty }],
      shippingAddress: address, customerName: user.name ?? address.recipientName, customerEmail: user.email ?? user.contactEmail ?? null,
      nextBillingAt: new Date(Date.now() + (g.trialDays ?? 0) * DAY),
    });
    await this.audit(storeId, { id: userId, role: 'user' }, 'subscription_started', `${contract.customerName} subscribed to "${g.name}"`, String(contract._id), 'subscription');
    let first: { ok: boolean; orderNumber?: string; error?: string } | null = null;
    if ((g.trialDays ?? 0) === 0) first = await this.renew(String(contract._id));
    return { contractId: String(contract._id), firstOrder: first };
  }

  mine(storeId: string, userId: string) { return this.contracts.find({ storeId, userId }).sort({ createdAt: -1 }).limit(50).lean(); }

  async buyerAction(storeId: string, userId: string, id: string, action: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Subscription not found');
    const filter = { _id: id, storeId, userId };
    if (action === 'address') {
      const a = cleanAddress(body?.address); if (!a) throw new BadRequestException('A full delivery address is required');
      const c = await this.contracts.findOneAndUpdate({ ...filter, status: { $in: ['active', 'paused'] } }, { $set: { shippingAddress: a } }, { new: true }).lean();
      if (!c) throw new NotFoundException('Subscription not found');
      return c;
    }
    if (action === 'frequency') {
      const cur: any = await this.contracts.findOne({ ...filter, status: { $in: ['active', 'paused'] } }).lean(); if (!cur) throw new NotFoundException('Subscription not found');
      const g: any = await this.groups.findOne({ _id: cur.groupId, storeId }).lean();
      const opt = g?.options.find((o: any) => o.id === body?.optionId);
      if (!g || !opt) throw new BadRequestException('That frequency is not available any more');
      return this.contracts.findOneAndUpdate({ _id: cur._id, storeId, userId }, { $set: { optionId: opt.id, 'terms.unit': opt.unit, 'terms.count': opt.count, 'terms.discountPercent': opt.discountPercent } }, { new: true }).lean();
    }
    return this.apply(filter, action, 'buyer');
  }

  /** skip / pause / resume / cancel, each as a conditional update on the status read (a double click does nothing twice). */
  private async apply(filter: any, action: string, by: 'buyer' | 'store' | 'system'): Promise<any> {
    const cur: any = await this.contracts.findOne(filter).lean();
    if (!cur) throw new NotFoundException('Subscription not found');
    const now = new Date();
    let update: any; let from: string[];
    if (action === 'skip') { from = ['active']; update = { $set: { nextBillingAt: addInterval(new Date(cur.nextBillingAt), cur.terms.unit, cur.terms.count), stockFailures: 0 } }; }
    else if (action === 'pause') { from = ['active']; update = { $set: { status: 'paused', pausedReason: by === 'store' ? 'Paused by the store' : 'Paused by the customer' } }; }
    else if (action === 'resume') { from = ['paused']; update = { $set: { status: 'active', pausedReason: null, stockFailures: 0, dunningStage: 0, nextBillingAt: new Date(Math.max(now.getTime(), new Date(cur.nextBillingAt).getTime())) } }; }
    else if (action === 'cancel') { from = ['active', 'paused']; update = { $set: { status: 'cancelled', cancelledAt: now, pausedReason: null } }; }
    else throw new BadRequestException('Unknown action');
    const c: any = await this.contracts.findOneAndUpdate({ _id: cur._id, status: { $in: from as any }, ...(action === 'skip' || action === 'resume' ? { nextBillingAt: cur.nextBillingAt } : {}) }, update, { new: true }).lean();
    if (!c) throw new ConflictException(`This subscription cannot be ${action === 'skip' ? 'skipped' : action + 'd'} right now`);
    return c;
  }

  // ── renewal engine ────────────────────────────────────────────────────────
  /** Places the next order of a contract (idempotent per cycle). Never throws for business failures; returns what happened. */
  async renew(contractId: string, now: Date = new Date()): Promise<{ ok: boolean; orderNumber?: string; skipped?: string; error?: string }> {
    const c: any = await this.contracts.findOne({ _id: contractId, status: 'active', nextBillingAt: { $lte: now } }).lean();
    if (!c) return { ok: false, skipped: 'not due' };
    const cycleNo = c.cyclesDone + 1;
    // The unique {contract, cycle} row IS the claim: a parallel worker or a re-run gets E11000 and stops.
    try { await this.cycles.create({ contractId: String(c._id), storeId: c.storeId, cycleNo }); }
    catch (e: any) { if (e?.code === 11000) return { ok: false, skipped: 'already claimed' }; throw e; }
    const release = () => this.cycles.deleteOne({ contractId: String(c._id), cycleNo, status: 'creating' }).catch(() => undefined);
    // Re-check after the claim: cancelled / paused / skipped in the meantime means no order.
    const fresh: any = await this.contracts.findOne({ _id: c._id, status: 'active', cyclesDone: c.cyclesDone }).lean();
    if (!fresh) { await release(); return { ok: false, skipped: 'changed' }; }
    const store: any = await this.db.repositories.storeModel.findOne({ _id: c.storeId, isDelete: false }).select('sellerId name slug customDomain customDomainStatus primaryDomain status').lean();
    if (!store) { await release(); return { ok: false, skipped: 'store gone' }; }
    let draftId: string | null = null;
    try {
      const variantIds = c.items.map((i: any) => i.variantId);
      const variants: any[] = await (this.db.repositories.productVariantModel as any).find({ _id: { $in: variantIds }, storeId: c.storeId, isDelete: false }).select('price').lean();
      const price = new Map(variants.map((v) => [String(v._id), Number(v.price)]));
      if (c.items.some((i: any) => !price.has(i.variantId))) throw new Error('A product of this subscription is no longer available');
      const items = c.items.map((i: any) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity, unitPrice: discountedPrice(price.get(i.variantId) as number, c.terms.discountPercent) }));
      const goods = items.reduce((s: number, i: any) => s + i.unitPrice * i.quantity, 0);
      const drafts = this.moduleRef.get(DraftOrdersService, { strict: false });
      const a = c.shippingAddress;
      const draft: any = await drafts.create(c.storeId, String(store.sellerId), {
        customerId: c.userId, customerName: c.customerName || a.recipientName, customerEmail: c.customerEmail ?? undefined, customerPhone: a.phoneNumber,
        items, shippingAmount: c.terms.shippingAmount ?? 0, taxAmount: round2(goods * (c.terms.taxPercent ?? 0) / 100),
        notes: `Subscription "${c.terms.name}" - delivery ${cycleNo}`, shippingAddress: { recipientName: a.recipientName, addressLine1: a.addressLine1, addressLine2: a.addressLine2, city: a.city, state: a.state, zipCode: a.zipCode, phoneNumber: a.phoneNumber },
      } as any);
      draftId = String(draft._id);
      const done: any = await drafts.complete(c.storeId, String(store.sellerId), draftId);
      const scheduled = new Date(c.nextBillingAt);
      let next = addInterval(scheduled, c.terms.unit, c.terms.count);
      if (next.getTime() <= now.getTime()) next = addInterval(now, c.terms.unit, c.terms.count); // a long outage never causes a burst of catch-up orders
      const finished = c.terms.maxCycles != null && cycleNo >= c.terms.maxCycles;
      await this.cycles.updateOne({ contractId: String(c._id), cycleNo }, { $set: { status: 'ordered', orderId: done.orderId, amount: round2(draft.total ?? goods) } });
      await this.contracts.updateOne({ _id: c._id, cyclesDone: c.cyclesDone }, { $set: { cyclesDone: cycleNo, lastOrderId: done.orderId, lastOrderAt: now, nextBillingAt: next, stockFailures: 0, dunningStage: 0, ...(finished ? { status: 'completed' } : {}) } });
      await this.notify('subscription_renewal_placed', store, c, { orderNumber: done.orderNumber, orderId: done.orderId, nextDate: finished ? '' : next.toISOString().slice(0, 10), amountDue: `${round2(draft.total ?? goods)} ${draft.currency ?? ''}`.trim() });
      return { ok: true, orderNumber: done.orderNumber };
    } catch (e: any) {
      if (draftId) { try { await this.moduleRef.get(DraftOrdersService, { strict: false }).deleteDraft(c.storeId, String(store.sellerId), draftId); } catch { /* best effort */ } }
      await release();
      const msg = String(e?.message ?? e).slice(0, 200);
      const failures = (c.stockFailures ?? 0) + 1;
      if (failures >= STOCK_FAILURES_BEFORE_PAUSE) {
        await this.contracts.updateOne({ _id: c._id, status: 'active' }, { $set: { status: 'paused', pausedReason: `Could not place the order: ${msg}`, stockFailures: failures } });
        await this.notify('subscription_paused', store, c, { reason: `We could not place your order: ${msg}` });
      } else {
        await this.contracts.updateOne({ _id: c._id, status: 'active' }, { $set: { stockFailures: failures, nextBillingAt: new Date(now.getTime() + DAY) } }); // try again tomorrow
      }
      return { ok: false, error: msg };
    }
  }

  async runDue(now: Date = new Date(), limit = 200) {
    const due: any[] = await this.contracts.find({ status: 'active', nextBillingAt: { $lte: now } }).sort({ nextBillingAt: 1 }).limit(limit).select('_id').lean();
    let ordered = 0;
    for (const d of due) { try { const r = await this.renew(String(d._id), now); if (r.ok) ordered++; } catch (e: any) { this.log.warn(`renew ${d._id}: ${e?.message}`); } }
    return { due: due.length, ordered };
  }

  /** Unpaid renewal orders: reminder at day 3 and 5, pause at day 7 (each stage is claimed once). */
  async runDunning(now: Date = new Date(), limit = 300) {
    const list: any[] = await this.contracts.find({ status: 'active', lastOrderId: { $ne: null }, dunningStage: { $lt: 3 } }).limit(limit).lean();
    let sent = 0;
    for (const c of list) {
      try {
        const order: any = await this.db.repositories.orderModel.findOne({ _id: c.lastOrderId }).select('isPaid createdAt orderStatus sellerOrders.status').lean();
        if (!order || order.isPaid) continue;
        const age = (now.getTime() - new Date(order.createdAt).getTime()) / DAY;
        const stage = age >= PAUSE_AFTER_DAYS ? 3 : age >= REMINDER_DAYS[1] ? 2 : age >= REMINDER_DAYS[0] ? 1 : 0;
        if (stage <= c.dunningStage) continue;
        const store: any = await this.db.repositories.storeModel.findById(c.storeId).select('name slug customDomain customDomainStatus primaryDomain').lean();
        const claimed: any = await this.contracts.findOneAndUpdate({ _id: c._id, status: 'active', dunningStage: c.dunningStage }, { $set: { dunningStage: stage, ...(stage === 3 ? { status: 'paused', pausedReason: 'Paused because the last order was not paid' } : {}) } }, { new: true }).lean();
        if (!claimed) continue;
        if (stage === 3) await this.notify('subscription_paused', store, c, { reason: 'Your last order was not paid, so the subscription is paused. Resume it any time from your account.' });
        else await this.notify('subscription_payment_reminder', store, c, { orderId: c.lastOrderId, orderNumber: String(order.orderNumber ?? ''), reason: stage === 2 ? 'This is the last reminder before the subscription is paused.' : 'Please pay your subscription order.' });
        sent++;
      } catch (e: any) { this.log.warn(`dunning ${c._id}: ${e?.message}`); }
    }
    return { sent };
  }

  private async notify(event: 'subscription_renewal_placed' | 'subscription_payment_reminder' | 'subscription_paused', store: any, c: any, v: { orderNumber?: string; orderId?: string; nextDate?: string; amountDue?: string; reason?: string }) {
    try {
      if (!this.notifications || !c.customerEmail) return;
      const base = storePublicUrl(store);
      let orderNumber = v.orderNumber ?? '';
      if (!orderNumber && v.orderId) { const o: any = await this.db.repositories.orderModel.findById(v.orderId).select('orderNumber').lean(); orderNumber = String(o?.orderNumber ?? ''); }
      const orderUrl = base ? `${base}${v.orderId ? `/orders/${v.orderId}` : '/subscriptions'}` : '';
      await this.notifications.sendCustomerEmail({
        to: c.customerEmail, storeId: c.storeId, event, orderId: v.orderId ?? null,
        vars: { storeName: store?.name ?? '', customerName: c.customerName ?? '', orderNumber, orderUrl, planName: c.terms?.name ?? '', nextDate: v.nextDate ?? '', amountDue: v.amountDue ?? '', reason: v.reason ?? '' },
        ...(orderUrl ? { cta: { label: event === 'subscription_paused' ? 'Manage subscription' : 'View order', url: event === 'subscription_paused' ? `${base}/subscriptions` : orderUrl } } : {}),
      });
    } catch { /* a mail problem never blocks billing */ }
  }

  /** Hourly (minute 10), single instance (Redis lock). */
  @Cron('10 * * * *')
  async cron() {
    if (!this.redis) return;
    const r = await this.redis.withLock('cron-lock:subscription-renewals', 30 * 60_000, async () => {
      const a = await this.runDue(); const b = await this.runDunning();
      if (a.ordered || b.sent) this.log.log(`Subscriptions: ${a.ordered} renewal order(s), ${b.sent} reminder(s)`);
    });
    if (r === 'lock_not_acquired') this.log.debug('Skipped subscription renewals: lock held elsewhere (or Redis unavailable)');
  }
}
