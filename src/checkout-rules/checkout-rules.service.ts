/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { CheckoutRule, CheckoutRuleDocument } from './checkout-rules.schema';
import { Evaluation, FIELDS, MAX_RULES_PER_STORE, RuleContext, RuleLike, applyShippingRules, evaluateRules, filterPaymentMethods, shippingZoneHidden, validateRule } from './checkout-rules.util';

type Actor = { id: string; role: string };
const isOid = (v: unknown) => typeof v === 'string' && Types.ObjectId.isValid(v);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface RuleLine { productId: string; quantity: number; total: number; type?: string }
export interface RuleInputs { lines: RuleLine[]; customerTags?: string[]; isB2B?: boolean; isGuest?: boolean; address?: { country?: string | null; city?: string | null; state?: string | null; zipCode?: string | null } | null }

export function buildContext(i: RuleInputs): RuleContext {
  const lines = i.lines.map((l) => ({ productId: String(l.productId), quantity: l.quantity, total: l.total }));
  const a = i.address ?? null;
  const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    subtotal: round2(lines.reduce((s, l) => s + l.total, 0)), itemCount: lines.reduce((s, l) => s + l.quantity, 0), lineCount: lines.length,
    maxLineQuantity: lines.reduce((m, l) => Math.max(m, l.quantity), 0), lines, productIds: [...new Set(lines.map((l) => l.productId))],
    customerTags: i.customerTags ?? [], isB2B: !!i.isB2B, isGuest: !!i.isGuest,
    hasDigital: i.lines.some((l) => l.type === 'digital'), hasPhysical: i.lines.some((l) => l.type !== 'digital'),
    country: t(a?.country), city: t(a?.city), state: t(a?.state), postalCode: t(a?.zipCode),
  };
}

@Injectable()
export class CheckoutRulesService {
  constructor(
    @InjectModel(CheckoutRule.name) private readonly rules: Model<CheckoutRuleDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
  ) {}

  private audit(storeId: string, actor: Actor, action: string, description: string, targetId?: string) {
    return this.activity.log({ storeId, category: 'checkout_rules', action, description, actorId: actor.id, actorRole: actor.role, targetId: targetId ?? '', targetType: 'checkout_rule' } as any).catch(() => undefined);
  }

  // ── seller CRUD ───────────────────────────────────────────────────────────
  list(storeId: string) { return this.rules.find({ storeId }).sort({ type: 1, priority: 1, createdAt: 1 }).lean(); }

  async create(storeId: string, actor: Actor, body: any) {
    const v = validateRule(body, false); if (!v.ok) throw new BadRequestException(v.error);
    if ((await this.rules.countDocuments({ storeId })) >= MAX_RULES_PER_STORE) throw new BadRequestException(`At most ${MAX_RULES_PER_STORE} rules per store`);
    if (v.data.type === 'discount' || v.data.type === 'validation') await this.assertProducts(storeId, v.data);
    const r = await this.rules.create({ ...v.data, storeId });
    await this.audit(storeId, actor, 'checkout_rule_created', `Checkout rule "${r.name}" (${r.type}) created`, String(r._id));
    return r.toObject();
  }

  async update(storeId: string, actor: Actor, id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Rule not found');
    const cur: any = await this.rules.findOne({ _id: id, storeId }).select('type').lean();
    if (!cur) throw new NotFoundException('Rule not found');
    const v = validateRule(body, true, cur.type); if (!v.ok) throw new BadRequestException(v.error);
    await this.assertProducts(storeId, v.data);
    const r: any = await this.rules.findOneAndUpdate({ _id: id, storeId }, { $set: v.data }, { new: true }).lean();
    await this.audit(storeId, actor, 'checkout_rule_updated', `Checkout rule "${r.name}" updated`, id);
    return r;
  }

  async remove(storeId: string, actor: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('Rule not found');
    const r: any = await this.rules.findOneAndDelete({ _id: id, storeId }).lean();
    if (!r) throw new NotFoundException('Rule not found');
    await this.audit(storeId, actor, 'checkout_rule_deleted', `Checkout rule "${r.name}" deleted`, id);
    return { success: true };
  }

  /** Products named in a rule must belong to the store (a rule can never point at another store's data). */
  private async assertProducts(storeId: string, data: any) {
    const ids: string[] = [...(data?.action?.productIds ?? []), ...((data?.conditions ?? []) as any[]).filter((c) => c.field === 'productIds').flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value]))];
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    const n = await (this.db.repositories.productModel as any).countDocuments({ _id: { $in: unique }, storeId, isDelete: false });
    if (n !== unique.length) throw new BadRequestException('One or more products do not belong to this store');
  }

  // ── evaluation ────────────────────────────────────────────────────────────
  async evaluate(storeId: string, ctx: RuleContext, includeDrafts = false): Promise<Evaluation> {
    const rows: any[] = await this.rules.find({ storeId, ...(includeDrafts ? {} : { status: 'active' }) }).lean();
    return evaluateRules(rows.map((r) => ({ ...r, status: 'active' } as RuleLike)), ctx);
  }

  async hasActiveRules(storeId: string): Promise<boolean> { return !!(await this.rules.exists({ storeId, status: 'active' })); }

  /** Buyer facts (tags / guest) from the logged-in user of THIS store. */
  async customerFacts(storeId: string, userId: string | null | undefined): Promise<{ customerTags: string[]; isGuest: boolean; isB2B: boolean }> {
    if (!userId || !isOid(String(userId))) return { customerTags: [], isGuest: true, isB2B: false };
    const u: any = await (this.db.repositories.userModel as any).findOne({ _id: userId, storeId }).select('tags isGuest').lean();
    const tags: string[] = Array.isArray(u?.tags) ? u.tags.filter((t: unknown) => typeof t === 'string') : [];
    return { customerTags: tags, isGuest: !!u?.isGuest, isB2B: tags.some((t) => t.toLowerCase() === 'b2b') };
  }

  /** Context + evaluation of ONE store's part of a checkout document (the same call the cart preview and the final checkout use). */
  async evaluateCheckoutStore(checkout: any, userId: string, storeId: string, opts: { withAddress?: boolean } = {}): Promise<{ ev: Evaluation; ctx: RuleContext } | null> {
    if (!(await this.hasActiveRules(storeId))) return null;
    const items = (checkout.items ?? []).filter((i: any) => String(i.storeId) === String(storeId));
    if (!items.length) return null;
    let address: any = null;
    if (opts.withAddress !== false && checkout.addressId && isOid(String(checkout.addressId))) address = await (this.db.repositories.addressModel as any).findOne({ _id: String(checkout.addressId), userId }).select('country city state zipCode').lean();
    const facts = await this.customerFacts(storeId, userId);
    const ctx = buildContext({
      lines: items.map((i: any) => ({ productId: i.productId, quantity: i.quantity, total: Number(i.totalPrice) || 0, type: i.type })),
      customerTags: facts.customerTags, isGuest: facts.isGuest, isB2B: facts.isB2B || !!checkout.b2b, address,
    });
    return { ev: await this.evaluate(storeId, ctx), ctx };
  }

  /** The buyer's cart (+ default address) evaluated for delivery rules. Null when the store has no active rules. */
  async evaluateUserCart(storeId: string, userId: string): Promise<Evaluation | null> {
    if (!(await this.hasActiveRules(storeId))) return null;
    const cart: any = await (this.db.repositories.cartModel as any).findOne({ userId, storeId }).select('items').lean();
    const items: any[] = cart?.items ?? [];
    if (!items.length) return null;
    const address = await (this.db.repositories.addressModel as any).findOne({ userId, isDefault: true, isDelete: false }).select('country city state zipCode').lean();
    const facts = await this.customerFacts(storeId, userId);
    return this.evaluate(storeId, buildContext({ lines: items.map((i) => ({ productId: i.productId, quantity: i.quantity, total: round2(Number(i.price) * i.quantity) || 0 })), address, ...facts }));
  }

  throwIfBlocked(ev: Evaluation) { if (ev.blocks.length) throw new BadRequestException(ev.blocks[0].message); }

  /** Server-side guard used at address/shipping and payment time. Throws the customer-facing message of the first matching block rule. */
  async enforceCheckout(checkout: any, userId: string, opts: { paymentMethod?: string; zoneIds?: string[]; zonesOfStore?: Record<string, any[]> } = {}): Promise<void> {
    const storeIds = [...new Set<string>((checkout.items ?? []).map((i: any) => String(i.storeId)))];
    for (const storeId of storeIds) {
      const r = await this.evaluateCheckoutStore(checkout, userId, storeId); if (!r) continue;
      this.throwIfBlocked(r.ev);
      if (opts.paymentMethod && storeIds.length === 1) {
        const f = filterPaymentMethods([opts.paymentMethod], r.ev);
        if (f.methods.length === 0) throw new BadRequestException('This payment method is not available for your order.');
      }
      if (opts.zoneIds?.length) {
        const universe = opts.zonesOfStore?.[storeId] ?? [];
        const shown = universe.length ? applyShippingRules(universe, r.ev) : null;
        if (shown && !shown.ignored && opts.zoneIds.some((id) => universe.some((z: any) => String(z._id) === id) && shippingZoneHidden(universe.find((z: any) => String(z._id) === id), r.ev))) throw new BadRequestException('That delivery option is not available for your order.');
      }
    }
  }

  // ── seller test tool ──────────────────────────────────────────────────────
  /** "What would happen for this cart?" Takes a sample cart typed by the seller; touches nothing. */
  async test(storeId: string, body: any) {
    const s = body?.sample ?? {};
    const lines: RuleLine[] = Array.isArray(s.lines) && s.lines.length <= 50 ? s.lines.map((l: any) => ({ productId: String(l?.productId ?? ''), quantity: Math.min(Math.max(Math.floor(Number(l?.quantity) || 1), 1), 9999), total: Math.max(Number(l?.total) || 0, 0), type: l?.type === 'digital' ? 'digital' : 'physical' })) : [];
    if (!lines.length) throw new BadRequestException('Add at least one product line to test');
    const tags = Array.isArray(s.customerTags) ? s.customerTags.filter((t: unknown) => typeof t === 'string').slice(0, 20) : [];
    const ctx = buildContext({ lines, customerTags: tags, isB2B: s.isB2B === true, isGuest: s.isGuest === true, address: { country: s.country ?? null, city: s.city ?? null, state: s.state ?? null, zipCode: s.postalCode ?? null } });
    const ev = await this.evaluate(storeId, ctx, body?.includeDrafts === true);
    const methods = Array.isArray(body?.methods) ? body.methods.filter((m: unknown) => typeof m === 'string').slice(0, 20) : ['stripe', 'cash_on_delivery', 'manual_bank_transfer'];
    const zones = (await (this.db.repositories.shippingZoneModel as any).find({ storeId, isDelete: false, status: 'active' }).select('name zoneType').lean()) as any[];
    return {
      context: { subtotal: ctx.subtotal, itemCount: ctx.itemCount, maxLineQuantity: ctx.maxLineQuantity },
      discount: ev.discount, blocks: ev.blocks,
      paymentMethods: filterPaymentMethods(methods, ev).methods,
      shippingZones: applyShippingRules(zones, ev).zones.map((z: any) => ({ id: String(z._id), name: z.name })),
    };
  }

  /** Buyer: what the rules do to the CURRENT CART (same evaluation as the final checkout, address unknown yet). */
  async previewCart(storeId: string, userId: string) {
    const cart: any = await (this.db.repositories.cartModel as any).findOne({ userId, storeId }).select('items').lean();
    const items: any[] = cart?.items ?? [];
    if (!items.length || !(await this.hasActiveRules(storeId))) return { discount: { total: 0, applied: [] }, blocks: [], hiddenPaymentMethods: [], showOnlyPaymentMethods: null };
    const facts = await this.customerFacts(storeId, userId);
    const ctx = buildContext({ lines: items.map((i) => ({ productId: i.productId, quantity: i.quantity, total: round2(Number(i.price) * i.quantity) || 0 })), ...facts });
    const ev = await this.evaluate(storeId, ctx);
    return { discount: { total: ev.discount.total, applied: ev.discount.applied.map((a) => ({ label: a.label, amount: a.amount })) }, blocks: ev.blocks.map((b) => b.message), hiddenPaymentMethods: ev.payment.hidden, showOnlyPaymentMethods: ev.payment.showOnly };
  }

  /** For the field list shown in the seller editor. */
  fieldCatalog() { return Object.entries(FIELDS).map(([field, f]) => ({ field, kind: f.kind, needsAddress: !!f.address })); }
}
