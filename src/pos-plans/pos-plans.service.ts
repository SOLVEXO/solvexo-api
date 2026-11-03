/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PlatformTaxService } from '@/platform-tax/platform-tax.service';
import { toStripeAmount } from '@/common/stripe-amount.util';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { isPosEntitlementEnforced } from '../pos/guards/pos-entitlement.guard';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PosPlansService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly paymentGatewayService: PaymentGatewayService,
    @Optional() private readonly platformTax?: PlatformTaxService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Active plans only — seller-facing catalog, admin-authored and entirely dynamic. */
  async getActivePlans() {
    const plans = await this.r.posPlanModel.find({ isActive: true }).sort({ price: 1 });
    return {
      success: true,
      data: plans.map((p) => ({
        id: String(p._id),
        name: p.name,
        price: p.price,
        currency: p.currency,
        durationInDays: p.durationInDays,
        description: p.description,
        maxRegisters: (p as any).maxRegisters ?? null,
        maxEmployees: (p as any).maxEmployees ?? null,
        maxLocations: (p as any).maxLocations ?? null,
      })),
    };
  }

  /**
   * Current status = the most recent PosPurchase for this store, with
   * `active`/`expired` derived from `expiresAt` vs now on every read — never
   * stored, so it can't drift out of sync with `expiresAt`.
   */
  async getStatus(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);

    const purchase = await this.r.posPurchaseModel.findOne({ storeId }).sort({ purchasedAt: -1 });
    if (!purchase) {
      return { success: true, data: { status: 'none', enforced: isPosEntitlementEnforced() } };
    }

    const now = Date.now();
    const isActive = purchase.expiresAt.getTime() > now;
    const daysRemaining = isActive ? Math.ceil((purchase.expiresAt.getTime() - now) / DAY_MS) : 0;

    return {
      success: true,
      data: {
        status: isActive ? 'active' : 'expired',
        // Whether the backend is actually blocking selling for a store without an active plan
        // (POS_ENTITLEMENT_ENFORCED). Lets the app mirror the server instead of inventing a rule of its own.
        enforced: isPosEntitlementEnforced(),
        planName: purchase.planNameSnapshot,
        purchasedAt: purchase.purchasedAt,
        expiresAt: purchase.expiresAt,
        daysRemaining,
      },
    };
  }

  /**
   * Creates a one-time Stripe Checkout session (`mode: 'payment'`) priced
   * from the server-side PosPlan record — never trusts a client-supplied
   * price. `durationInDays` rides along in session metadata so the webhook
   * can compute `expiresAt` without re-fetching a possibly-since-edited plan.
   */
  async createCheckoutSession(storeId: string, sellerId: string, dto: CreateCheckoutSessionDto) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);

    const plan = await this.r.posPlanModel.findOne({ _id: dto.planId, isActive: true });
    if (!plan) throw new NotFoundException('Plan not found or no longer available');

    const stripe = this.paymentGatewayService.stripeClient;
    if (!stripe) throw new BadRequestException('Stripe is not configured on this environment');

    // Solvexo's own tax on this plan (null = none applies to this seller's country): Stripe adds it on top at checkout.
    const taxRateId = await this.platformTax?.taxRateIdForStore(storeId);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
          price_data: {
            currency: plan.currency.toLowerCase(),
            unit_amount: toStripeAmount(plan.price, plan.currency),
            product_data: {
              name: plan.name,
              description: plan.description ?? undefined,
            },
          },
          quantity: 1,
        },
      ],
      success_url: dto.successUrl,
      cancel_url: dto.cancelUrl,
      metadata: {
        type: 'pos_purchase',
        storeId,
        sellerId,
        planId: String(plan._id),
        durationInDays: String(plan.durationInDays),
      },
    });

    return { success: true, data: { url: session.url } };
  }

  /**
   * PUBLIC (no auth) status of a POS plan Checkout Session, for the portal's success page when its session cookie has not been
   * restored yet. The Stripe session id is itself the secret; the answer is limited to what the page needs. Anything that is not a
   * POS-plan session (or cannot be retrieved) is a plain 'unknown' — no amounts, emails or customer data, no extra oracle.
   */
  async getCheckoutSessionStatus(sessionId: string) {
    const unknown = { success: true, data: { status: 'unknown' as const, planActivated: false, storeId: null as string | null } };
    if (typeof sessionId !== 'string' || !/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId)) return unknown;
    const stripe = this.paymentGatewayService.stripeClient;
    if (!stripe) return unknown;
    let session: any;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      return unknown;
    }
    if (!session || session.mode !== 'payment' || session.metadata?.type !== 'pos_purchase') return unknown;
    const status = session.status === 'expired' ? 'expired'
      : session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') ? 'paid'
      : 'open';
    const planActivated = !!(await this.r.posPurchaseModel.exists({ stripeCheckoutSessionId: sessionId }));
    return { success: true, data: { status, planActivated, storeId: session.metadata?.storeId ? String(session.metadata.storeId) : null } };
  }
}
