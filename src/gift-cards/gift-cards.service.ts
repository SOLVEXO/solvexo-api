/* eslint-disable prettier/prettier */
import { Injectable, Optional, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { toStripeAmount } from '@/common/stripe-amount.util';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { StripeConnectService } from '../stripe-connect/stripe-connect.service';
import { CommissionRulesService } from '../commission-rules/commission-rules.service';
import { EmailService } from '@/otp/services/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdateGiftCardSettingsDto } from './dto/update-gift-card-settings.dto';
import { IssueManualGiftCardDto } from './dto/issue-manual-gift-card.dto';
import { CreatePurchaseIntentDto } from './dto/create-purchase-intent.dto';
import { randomBytes } from 'crypto';
import Stripe from 'stripe';

function generateGiftCardCode(): string {
  // Grouped for readability when a buyer types it in manually (e.g. reading
  // it off a printed/emailed card) — e.g. "GC4F2A-9KRT".
  const raw = randomBytes(5).toString('hex').toUpperCase();
  return `GC${raw.slice(0, 4)}-${raw.slice(4)}`;
}

@Injectable()
export class GiftCardsService {
  private stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly stripeConnectService: StripeConnectService,
    private readonly commissionRulesService: CommissionRulesService,
    // Global module; optional so the service still works if it is ever constructed without it.
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
    }
  }

  private get r() {
    return this.databaseService.repositories;
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async getOrCreateSettings(storeId: string) {
    let settings = await this.r.giftCardSettingsModel.findOne({ storeId });
    if (!settings) settings = await this.r.giftCardSettingsModel.create({ storeId });
    return settings;
  }

  // ── Seller-facing ─────────────────────────────────────────────────────────

  async getSettings(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const settings = await this.getOrCreateSettings(storeId);
    return { success: true, message: 'Gift card settings', data: settings };
  }

  async updateSettings(sellerId: string, storeId: string, dto: UpdateGiftCardSettingsDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    await this.getOrCreateSettings(storeId);
    const settings = await this.r.giftCardSettingsModel.findOneAndUpdate(
      { storeId },
      { $set: dto },
      { new: true },
    );
    return { success: true, message: 'Gift card settings updated', data: settings };
  }

  /** Seller issues a gift card directly — no purchase, e.g. a goodwill
   *  credit or service-recovery gesture — same pattern real platforms
   *  (Shopify's manual gift card issuance) offer alongside buyer purchase. */
  async issueManual(sellerId: string, storeId: string, dto: IssueManualGiftCardDto) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const currency = store.baseCurrency ?? 'USD';
    const settings = await this.getOrCreateSettings(storeId);

    const expiresAt = settings.neverExpires
      ? null
      : (() => { const d = new Date(); d.setMonth(d.getMonth() + settings.expiryMonths); return d; })();

    const giftCard = await this.createGiftCardRecord({
      storeId, currency, value: dto.value, issuedBy: 'manual',
      issuedByUserId: sellerId, recipientEmail: dto.recipientEmail ?? null,
      recipientName: dto.recipientName ?? null, message: dto.message ?? null,
      purchaserUserId: null, expiresAt,
    });

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_issued',
      description: `${giftCard.code} — ${currency} ${dto.value} issued manually`,
      actorId: sellerId, actorRole: 'seller', targetId: String(giftCard._id), targetType: 'gift_card',
    });

    if (dto.recipientEmail) {
      this.sendGiftCardEmail(storeId, dto.recipientEmail, dto.recipientName ?? null, store.name, giftCard.code, currency, dto.value, dto.message ?? null).catch(() => {});
    }

    return { success: true, message: 'Gift card issued', data: giftCard };
  }

  async listGiftCards(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.code) filter.code = new RegExp(String(query.code).trim(), 'i');

    const [items, total] = await Promise.all([
      this.r.giftCardModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.giftCardModel.countDocuments(filter),
    ]);
    return { success: true, message: 'Gift cards', data: { items, total, page, limit } };
  }

  /** Real "Edit existing card value" — the Tier-2 audit's disclosed gap
   *  (issuance was already real, but nothing let a seller correct/top-up/
   *  deduct an already-issued card's balance). `delta` can be positive
   *  (goodwill top-up, correcting an under-issue) or negative (correcting
   *  an over-issue, clawing back a mistaken credit) — never allowed to push
   *  `balance` below 0. Writes a real `GiftCardTransaction(type:'adjustment')`
   *  row, same audit-ledger convention every other balance change already uses. */
  async adjustBalance(sellerId: string, storeId: string, giftCardId: string, delta: number, reason: string, notify = false) {
    await this.verifyStoreOwnership(storeId, sellerId);
    if (!delta || !Number.isFinite(delta)) throw new BadRequestException('A non-zero adjustment amount is required');
    const rounded = this.round(delta);

    const giftCard = await this.r.giftCardModel.findOne({ _id: giftCardId, storeId, isDelete: false });
    if (!giftCard) throw new NotFoundException('Gift card not found');
    if (giftCard.status !== 'active') throw new BadRequestException('Only an active gift card can be adjusted');

    const newBalance = this.round(giftCard.balance + rounded);
    if (newBalance < 0) throw new BadRequestException(`This would take the balance below 0 (current: ${giftCard.balance}).`);

    const updated = await this.r.giftCardModel.findByIdAndUpdate(
      giftCardId, { $set: { balance: newBalance } }, { new: true },
    );

    await this.r.giftCardTransactionModel.create({
      storeId, giftCardId, type: 'adjustment', amount: rounded,
      balanceAfter: newBalance, description: (reason ?? '').trim() || (rounded > 0 ? 'Manual credit' : 'Manual deduction'),
    });

    await this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_adjusted',
      description: `${giftCard.code} — ${rounded > 0 ? '+' : ''}${rounded} ${giftCard.currency} (${reason || 'no reason given'})`,
      actorId: sellerId, actorRole: 'seller', targetId: giftCardId, targetType: 'gift_card',
    });

    let emailed: 'sent' | 'failed' | 'disabled' | 'no_recipient' | null = null;
    if (notify) {
      const cleanReason = (reason ?? '').trim();
      emailed = await this.notifyRecipient(storeId, giftCard, {
        change: `The balance changed from ${this.money(giftCard.currency, giftCard.balance)} to ${this.money(giftCard.currency, newBalance)}.`,
        reason: cleanReason ? `Note from the store: ${cleanReason}` : '',
        balance: this.money(giftCard.currency, newBalance),
      }, sellerId);
    }

    return { success: true, message: 'Gift card balance adjusted', data: updated, emailed };
  }

  async disableGiftCard(sellerId: string, storeId: string, giftCardId: string, notify = false) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const giftCard = await this.r.giftCardModel.findOneAndUpdate(
      { _id: giftCardId, storeId, isDelete: false },
      { status: 'disabled' },
      { new: true },
    );
    if (!giftCard) throw new NotFoundException('Gift card not found');

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_disabled',
      description: `${giftCard.code} disabled`, actorId: sellerId, actorRole: 'seller',
      targetId: giftCardId, targetType: 'gift_card',
    });

    let emailed: 'sent' | 'failed' | 'disabled' | 'no_recipient' | null = null;
    if (notify) {
      // Empty balance drops the "Balance now" line of the template — a disabled card has no usable balance.
      emailed = await this.notifyRecipient(storeId, giftCard, {
        change: 'This gift card has been disabled and can no longer be used at checkout.',
        reason: '',
        balance: '',
      }, sellerId);
    }

    return { success: true, message: 'Gift card disabled', data: giftCard, emailed };
  }

  /** Re-sends the original gift card email with the card's CURRENT balance (Shopify: "Send gift card"). */
  async resendGiftCardEmail(sellerId: string, storeId: string, giftCardId: string) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const giftCard = await this.r.giftCardModel.findOne({ _id: giftCardId, storeId, isDelete: false });
    if (!giftCard) throw new NotFoundException('Gift card not found');
    if (giftCard.status !== 'active') throw new BadRequestException('Only an active gift card can be emailed');
    if (!giftCard.recipientEmail) throw new BadRequestException('This gift card has no recipient email');

    const now = Date.now();
    const key = `${storeId}:${giftCardId}`;
    if (now - (this.resendAt.get(key) ?? 0) < 30_000) throw new BadRequestException('This gift card was just emailed. Please wait a moment.');
    this.resendAt.set(key, now);
    if (this.resendAt.size > 500) for (const [k, t] of this.resendAt) if (now - t > 30_000) this.resendAt.delete(k);

    const result = this.notificationsService
      ? await this.notificationsService.sendCustomerEmail({
          to: giftCard.recipientEmail, storeId, event: 'gift_card', force: true,
          vars: {
            customerName: giftCard.recipientName, giftCardValue: this.money(giftCard.currency, giftCard.balance),
            giftCardCode: giftCard.code, giftCardMessage: giftCard.message,
          },
        })
      : 'failed';
    if (result !== 'sent') this.resendAt.delete(key); // nothing went out: allow an immediate retry
    else this.logEmail(storeId, giftCard, 'resent', sellerId);
    return { success: result === 'sent', message: result === 'sent' ? `Gift card emailed to ${giftCard.recipientEmail}` : 'The email could not be sent', emailed: result };
  }

  private readonly resendAt = new Map<string, number>();

  private money(currency: string, value: number) {
    return `${currency} ${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }

  private logEmail(storeId: string, giftCard: any, what: string, actorId: string) {
    this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_email_sent',
      description: `${giftCard.code} — email (${what}) sent to ${giftCard.recipientEmail}`,
      actorId, actorRole: 'seller', targetId: String(giftCard._id), targetType: 'gift_card',
    });
  }

  private async notifyRecipient(
    storeId: string, giftCard: any, text: { change: string; reason: string; balance: string }, actorId: string,
  ): Promise<'sent' | 'failed' | 'disabled' | 'no_recipient'> {
    if (!giftCard.recipientEmail) return 'no_recipient';
    if (!this.notificationsService) return 'failed';
    const result = await this.notificationsService.sendCustomerEmail({
      to: giftCard.recipientEmail, storeId, event: 'gift_card_updated',
      vars: {
        customerName: giftCard.recipientName, giftCardCode: giftCard.code,
        giftCardBalance: text.balance, giftCardChange: text.change, giftCardReason: text.reason,
      },
    });
    if (result === 'sent') this.logEmail(storeId, giftCard, 'updated', actorId);
    return result;
  }

  // ── Buyer-facing ──────────────────────────────────────────────────────────

  async getPublicSettings(storeId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false, status: 'active' }).select('baseCurrency');
    if (!store) throw new NotFoundException('Store not found');
    const settings = await this.getOrCreateSettings(storeId);
    return {
      success: true,
      data: {
        purchaseEnabled: settings.purchaseEnabled,
        denominations: settings.denominations,
        currency: store.baseCurrency ?? 'USD',
      },
    };
  }

  private assertStripeConfigured() {
    if (!this.stripe) throw new BadRequestException('Online payments are not configured');
    return this.stripe;
  }

  /** Creates a standalone Stripe PaymentIntent for a gift-card purchase —
   *  deliberately outside the buyer Cart/Checkout/Order pipeline (a gift
   *  card isn't a Product — no variant, no shipping, no stock), same
   *  precedent as the platform-plans billing engine's own direct
   *  PaymentIntent/SetupIntent usage. Finalization happens the same way
   *  every other Stripe charge in this codebase does — via the existing
   *  webhook (`PaymentService.stripeWebhook`, keyed on this intent's
   *  `metadata.purpose`), never trusting a client-side "it succeeded" call. */
  async createPurchaseIntent(userId: string, storeId: string, dto: CreatePurchaseIntentDto) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false, status: 'active' });
    if (!store) throw new NotFoundException('Store not found');
    const settings = await this.getOrCreateSettings(storeId);
    if (!settings.purchaseEnabled) throw new BadRequestException('Gift cards aren\'t available for purchase at this store');

    const currency = store.baseCurrency ?? 'USD';
    const sendOn = this.parseSendOn(dto.sendOn, !!dto.recipientEmail);
    await this.exchangeRateService.assertSupportedCurrency(currency);
    const stripe = this.assertStripeConfigured();

    // Charged directly in the store's own real currency — matches
    // PaymentService.initiatePayment's own checkout Stripe charge (see its
    // `currency: checkout.currency.toLowerCase()`), not a separate USD-only
    // rule for gift cards. The gift card's face value is the same amount the
    // buyer is actually charged, no FX conversion involved.
    const amountCents = toStripeAmount(this.round(dto.amount), currency);
    if (amountCents < 50) throw new BadRequestException('Amount is too small to process');

    // The buyer's payment goes straight to the seller's own connected account
    // — previously it landed on the platform's shared account and the seller
    // was never credited for gift-card sales at all.
    const connectAccountId = await this.stripeConnectService.getEligibleConnectAccountForStore(storeId);
    if (!connectAccountId) {
      throw new BadRequestException("This store hasn't set up online card payments yet, so gift cards can't be purchased right now.");
    }
    const applicationFeeAmountCents = await this.commissionRulesService.cardApplicationFeeCents(storeId, amountCents, currency);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: currency.toLowerCase(),
      transfer_data: { destination: connectAccountId },
      application_fee_amount: applicationFeeAmountCents,
      metadata: {
        purpose: 'gift_card_purchase',
        connectedAccountId: connectAccountId,
        storeId,
        userId,
        amount: String(dto.amount),
        currency,
        recipientEmail: dto.recipientEmail ?? '',
        recipientName: dto.recipientName ?? '',
        message: (dto.message ?? '').slice(0, 480),
        sendOn: sendOn ? sendOn.toISOString().slice(0, 10) : '',
      },
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    return {
      success: true,
      message: 'Payment initiated',
      data: { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, amount: dto.amount, currency },
    };
  }

  /** The optional "send on" day of a gift (YYYY-MM-DD, taken as 00:00 UTC): today up to one year ahead, gifts only. */
  private parseSendOn(raw: string | undefined, isGift: boolean): Date | null {
    if (!raw) return null;
    if (!isGift) throw new BadRequestException('A delivery date only applies when the card is sent as a gift');
    const day = new Date(`${String(raw).slice(0, 10)}T00:00:00.000Z`);
    if (isNaN(day.getTime())) throw new BadRequestException('Choose a valid delivery date');
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const limit = new Date(today); limit.setUTCFullYear(limit.getUTCFullYear() + 1);
    // One day of slack: the buyer picks a date in their own time zone, which can still be "yesterday" in UTC.
    const earliest = new Date(today.getTime() - 24 * 3600 * 1000);
    if (day < earliest) throw new BadRequestException('The delivery date cannot be in the past');
    if (day > limit) throw new BadRequestException('The delivery date can be at most one year from today');
    return day;
  }

  private niceDate(d: Date) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  /** Called from PaymentService.stripeWebhook on `payment_intent.succeeded`
   *  when `metadata.purpose === 'gift_card_purchase'` — mirrors
   *  finalizePaymentIntent's dedup convention (a redelivered webhook must
   *  never issue the gift card twice). */
  async finalizeGiftCardPurchase(paymentIntent: { id: string; metadata: Record<string, string> }) {
    const existing = await this.r.giftCardTransactionModel.findOne({ checkoutId: paymentIntent.id, type: 'issue' });
    if (existing) return; // already processed this exact PaymentIntent

    const { storeId, userId, amount, currency, recipientEmail, recipientName, message, sendOn } = paymentIntent.metadata;
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) return;

    const settings = await this.getOrCreateSettings(storeId);
    const expiresAt = settings.neverExpires
      ? null
      : (() => { const d = new Date(); d.setMonth(d.getMonth() + settings.expiryMonths); return d; })();

    const value = parseFloat(amount) || 0;

    // Shopify: the recipient is optional. Without one the card is for the buyer themselves, so the code goes to
    // the buyer's own email (a guest checkout keeps the real address in `contactEmail`).
    const purchaser: any = userId
      ? await this.r.userModel.findById(userId).select('name email contactEmail isGuest').lean()
      : null;
    const purchaserEmail: string | null = purchaser ? ((purchaser.isGuest ? purchaser.contactEmail : purchaser.email) || null) : null;
    const isGift = !!recipientEmail;
    const deliverTo = recipientEmail || purchaserEmail;
    // A gift for a future day waits (the daily job emails it); anything else goes out now.
    const scheduledFor = isGift && sendOn ? new Date(`${sendOn}T00:00:00.000Z`) : null;
    const isScheduled = !!scheduledFor && !isNaN(scheduledFor.getTime()) && scheduledFor.getTime() > Date.now();

    const giftCard = await this.createGiftCardRecord({
      storeId, currency: currency || 'USD', value, issuedBy: 'purchase',
      issuedByUserId: null, purchaserUserId: userId,
      recipientEmail: deliverTo, recipientName: recipientName || (isGift ? null : (purchaser?.name ?? null)),
      message: message || null, expiresAt, purchaseIntentId: paymentIntent.id,
      deliverAt: isScheduled ? scheduledFor : null, deliveredAt: isScheduled ? null : new Date(),
    });

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'gift_card_purchased',
      description: `${giftCard.code} — ${currency} ${value} purchased`,
      actorId: userId, actorRole: 'user', targetId: String(giftCard._id), targetType: 'gift_card',
    });

    if (deliverTo && !isScheduled) {
      this.sendGiftCardEmail(String(store._id), deliverTo, giftCard.recipientName ?? null, store.name, giftCard.code, currency || 'USD', value, message || null).catch(() => {});
    }
    // A gift: tell the buyer it was sent / when it will be (the code stays with the recipient).
    if (isGift && purchaserEmail && purchaserEmail.toLowerCase() !== String(recipientEmail).toLowerCase() && this.notificationsService) {
      this.notificationsService.sendCustomerEmail({
        to: purchaserEmail, storeId: String(store._id), event: 'gift_card_sent',
        vars: {
          customerName: purchaser?.name ?? null, giftCardValue: this.money(currency || 'USD', value),
          giftCardDelivery: isScheduled ? `will be emailed to ${recipientEmail} on ${this.niceDate(scheduledFor as Date)}` : `was emailed to ${recipientEmail}`,
        },
      }).catch(() => {});
    }
  }

  /** Daily/hourly job: emails every scheduled gift whose day has come. Each card is claimed first (atomic), so two
   *  instances or a retry can never send it twice; a failed send releases the claim for the next run (for 7 days). */
  async processScheduledDeliveries(): Promise<{ sent: number; failed: number }> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const due: any[] = await this.r.giftCardModel
      .find({ deliverAt: { $ne: null, $lte: now, $gt: weekAgo }, deliveredAt: null, status: 'active', isDelete: false })
      .limit(200).lean();
    let sent = 0; let failed = 0;
    for (const card of due) {
      const claimed = await this.r.giftCardModel.findOneAndUpdate({ _id: card._id, deliveredAt: null }, { $set: { deliveredAt: now } });
      if (!claimed) continue;
      let ok = false;
      try {
        if (card.recipientEmail && this.notificationsService) {
          const result = await this.notificationsService.sendCustomerEmail({
            to: card.recipientEmail, storeId: card.storeId, event: 'gift_card',
            vars: { customerName: card.recipientName, giftCardValue: this.money(card.currency, card.balance), giftCardCode: card.code, giftCardMessage: card.message },
          });
          ok = result === 'sent';
        }
      } catch { ok = false; }
      if (ok) { sent++; this.logEmail(card.storeId, card, 'scheduled delivery', card.purchaserUserId ?? ''); }
      else { failed++; await this.r.giftCardModel.updateOne({ _id: card._id }, { $set: { deliveredAt: null } }); }
    }
    return { sent, failed };
  }

  // ── Checkout redemption (called from CheckoutService) ────────────────────

  async findRedeemable(storeId: string, code: string) {
    return this.r.giftCardModel.findOne({
      storeId, code: code.toUpperCase(), status: 'active', isDelete: false,
      balance: { $gt: 0 },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
  }

  /** Decrements balance at order-placement time (never at apply-time — an
   *  abandoned checkout must not burn a gift card's balance), mirroring the
   *  Coupon usageCount / RewardVoucher status pattern. */
  async redeemAtOrderPlacement(storeId: string, code: string, amount: number, checkoutId: string, orderId: string) {
    const giftCard = await this.r.giftCardModel.findOneAndUpdate(
      { storeId, code: code.toUpperCase(), status: 'active', balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true },
    );
    if (!giftCard) return; // already spent/disabled between apply and placement — the charge already succeeded, so silently skip rather than fail the whole order

    await this.r.giftCardTransactionModel.create({
      storeId, giftCardId: String(giftCard._id), type: 'redeem', amount: -amount,
      balanceAfter: giftCard.balance, checkoutId, orderId, description: 'Applied at checkout',
    });
  }

  /**
   * Mirror of `redeemAtOrderPlacement` for the refund direction — previously
   * nothing ever called this: cancelling/refunding/returning an order that
   * had a gift card applied permanently burned that value, it never came
   * back onto the card. Called from OrdersService (cancellation + return
   * approval) and RefundRequestService.approve(), for exactly the amount of
   * `giftCardDiscountUSD` actually being refunded on this pass — never the
   * card's full original value, so a partial-item refund only restores its
   * own share.
   *
   * `idempotencyKey` must be unique per refund *event* (not just per order —
   * a single order can be partially refunded more than once over time), e.g.
   * `cancel:{orderId}:{itemId1,itemId2}` or a refund-request's own id. Reuses
   * the `checkoutId` column to carry it (this row isn't tied to a checkout),
   * checked before writing so a retried/duplicated refund call never
   * double-credits the card.
   */
  async restoreOnRefund(storeId: string, code: string, amount: number, orderId: string, idempotencyKey: string, description = 'Restored from refund') {
    if (!code || !(amount > 0)) return;
    const rounded = this.round(amount);

    const already = await this.r.giftCardTransactionModel.findOne({
      storeId, type: 'refund', checkoutId: idempotencyKey,
    });
    if (already) return; // this exact refund event already restored the balance

    const giftCard = await this.r.giftCardModel.findOneAndUpdate(
      { storeId, code: code.toUpperCase() },
      { $inc: { balance: rounded } },
      { new: true },
    );
    if (!giftCard) return; // gift card record no longer exists — nothing to restore onto

    await this.r.giftCardTransactionModel.create({
      storeId, giftCardId: String(giftCard._id), type: 'refund', amount: rounded,
      balanceAfter: giftCard.balance, checkoutId: idempotencyKey, orderId, description,
    });
  }

  /** Exposes the per-transaction ledger a seller can currently never see —
   *  every issue/redeem/refund row for one gift card, newest first. */
  async listTransactions(sellerId: string, storeId: string, giftCardId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const giftCard = await this.r.giftCardModel.findOne({ _id: giftCardId, storeId, isDelete: false });
    if (!giftCard) throw new NotFoundException('Gift card not found');

    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));

    const [items, total] = await Promise.all([
      this.r.giftCardTransactionModel.find({ storeId, giftCardId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.giftCardTransactionModel.countDocuments({ storeId, giftCardId }),
    ]);
    return { success: true, message: 'Gift card transactions', data: { items, total, page, limit, giftCard } };
  }

  private async createGiftCardRecord(opts: {
    storeId: string; currency: string; value: number; issuedBy: 'purchase' | 'manual';
    issuedByUserId: string | null; purchaserUserId: string | null; recipientEmail: string | null;
    recipientName: string | null; message: string | null; expiresAt: Date | null; purchaseIntentId?: string;
    deliverAt?: Date | null; deliveredAt?: Date | null;
  }) {
    let giftCard: any = null;
    for (let attempt = 0; attempt < 3 && !giftCard; attempt++) {
      try {
        giftCard = await this.r.giftCardModel.create({
          storeId: opts.storeId, code: generateGiftCardCode(), currency: opts.currency,
          initialValue: opts.value, balance: opts.value, issuedBy: opts.issuedBy,
          issuedByUserId: opts.issuedByUserId, purchaserUserId: opts.purchaserUserId,
          recipientEmail: opts.recipientEmail, recipientName: opts.recipientName,
          message: opts.message, expiresAt: opts.expiresAt,
          deliverAt: opts.deliverAt ?? null, deliveredAt: opts.deliveredAt ?? null,
        });
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // duplicate code — regenerate and retry
      }
    }
    if (!giftCard) throw new BadRequestException('Could not generate a gift card code, please try again');

    await this.r.giftCardTransactionModel.create({
      storeId: opts.storeId, giftCardId: String(giftCard._id), type: 'issue',
      amount: opts.value, balanceAfter: giftCard.balance,
      checkoutId: opts.purchaseIntentId ?? null, description: opts.issuedBy === 'purchase' ? 'Purchased' : 'Issued manually',
    });

    return giftCard;
  }

  private async sendGiftCardEmail(
    storeId: string, to: string, recipientName: string | null, storeName: string, code: string,
    currency: string, value: number, message: string | null,
  ) {
    if (this.notificationsService) {
      // The store's Customer-notification settings decide on/off, text, sender and reply-to.
      const result = await this.notificationsService.sendCustomerEmail({
        to, storeId, event: 'gift_card',
        vars: { customerName: recipientName, giftCardValue: `${currency} ${value}`, giftCardCode: code, giftCardMessage: message },
      });
      if (result !== 'failed') return;
    }
    const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,';
    const noteBlock = message ? `<p style="font-style:italic;color:#555">"${message}"</p>` : '';
    await this.emailService.sendMail(
      to,
      `You've received a ${currency} ${value} gift card from ${storeName}`,
      `<div style="font-family:sans-serif">
        <p>${greeting}</p>
        <p>You've received a gift card for <strong>${storeName}</strong>.</p>
        ${noteBlock}
        <p style="font-size:24px;font-weight:bold;letter-spacing:1px;background:#f5f5f5;padding:16px;border-radius:8px;text-align:center">${code}</p>
        <p>Enter this code at checkout on ${storeName}'s store to redeem it.</p>
      </div>`,
      null,
      undefined,
      undefined,
      storeName,
    );
  }
}
