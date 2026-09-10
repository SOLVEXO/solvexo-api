/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PosPlansService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly paymentGatewayService: PaymentGatewayService,
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
      return { success: true, data: { status: 'none' } };
    }

    const now = Date.now();
    const isActive = purchase.expiresAt.getTime() > now;
    const daysRemaining = isActive ? Math.ceil((purchase.expiresAt.getTime() - now) / DAY_MS) : 0;

    return {
      success: true,
      data: {
        status: isActive ? 'active' : 'expired',
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

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: plan.currency.toLowerCase(),
            unit_amount: Math.round(plan.price * 100),
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
}
