/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { PaymentService } from '../payment/payment.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { toDecryptedPaymentConfig } from './integration-credentials.helper';

/** Seller's own gateways whose result arrives asynchronously (webhook / browser return / Easypaisa app approval). */
const GATEWAY_TYPES = ['safepay', 'jazzcash', 'payfast', 'easypaisa'] as const;
const GATEWAY_NAMES: Record<string, string> = { safepay: 'Safepay', jazzcash: 'JazzCash', payfast: 'PayFast', easypaisa: 'Easypaisa' };
/** A buyer normally finishes a hosted gateway page within minutes; past this the result is treated as missing. */
const STUCK_AFTER_MS = 60 * 60_000;
/** Older sessions are abandoned checkouts, not lost payments — never alert on them. */
const LOOKBACK_MS = 48 * 60 * 60_000;
const BATCH = 200;

/**
 * Safety net for gateway payments whose result never reached Solvexo (webhook not delivered, buyer closed the tab
 * before the return page). For each pending session older than an hour:
 *  1. re-ask the gateway (`verifyPayment`) — when it confirms PAID and the amount matches what we charged, the order
 *     is created through the same `finalizeGatewayPayment` path the webhook uses (idempotent per session);
 *  2. otherwise the store owner gets ONE notification to check that payment in their gateway portal.
 * A gateway without an inquiry API (PayFast today) always answers `pending`, so its sessions only ever alert.
 */
@Injectable()
export class StuckGatewayPaymentsService {
  private readonly logger = new Logger(StuckGatewayPaymentsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly registry: PaymentProviderRegistry,
    private readonly paymentService: PaymentService,
    private readonly notifications: NotificationsService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  /**
   * Asks the gateway for one session's real result and acts on it through the same checks the webhook uses:
   * paid + amount/store match -> order created (`finalizeGatewayPayment`, idempotent per session); failed -> checkout
   * reopened. Throws on an amount/store mismatch (no order). Also used right after an Easypaisa app approval.
   */
  async reconcileSession(storeId: string, providerKey: string, sessionId: string, source: string): Promise<'paid' | 'failed' | 'pending'> {
    const integration = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'payment', provider: providerKey });
    if (!integration || !this.registry.isSupported(integration.provider)) return 'pending';
    const provider = this.registry.resolve(integration.provider);
    const status = await provider.verifyPayment(sessionId, toDecryptedPaymentConfig(integration)).catch(() => null);
    if (status?.status === 'paid') {
      await this.paymentService.assertGatewayPaymentMatches({
        providerSessionId: sessionId,
        paymentType: integration.provider,
        storeId,
        paidAmount: status.amount,
        paidCurrency: status.currency,
      });
      await this.paymentService.finalizeGatewayPayment(sessionId, integration.provider);
      return 'paid';
    }
    if (status?.status === 'failed') {
      await this.paymentService.failGatewayPayment(sessionId, integration.provider, `Gateway reported failed (${source})`);
      return 'failed';
    }
    return 'pending';
  }

  async processStuckPayments(now = new Date()): Promise<{ checked: number; recovered: number; alerted: number }> {
    const { paymentTransactionModel, checkoutModel, storeModel } = this.repos;
    const txns: any[] = await paymentTransactionModel
      .find({
        isDelete: false,
        status: 'pending',
        paymentType: { $in: GATEWAY_TYPES },
        providerSessionId: { $ne: null },
        stuckAlertSentAt: null,
        createdAt: { $gte: new Date(now.getTime() - LOOKBACK_MS), $lte: new Date(now.getTime() - STUCK_AFTER_MS) },
      })
      .sort({ createdAt: 1 })
      .limit(BATCH)
      .lean();

    let recovered = 0;
    let alerted = 0;
    for (const txn of txns) {
      try {
        const checkout: any = await checkoutModel.findById(txn.checkoutId).select('status items.storeId').lean();
        const storeId: string | undefined = checkout?.items?.[0]?.storeId ? String(checkout.items[0].storeId) : undefined;
        if (!checkout || !storeId || checkout.status === 'completed') {
          // Completed by another path (or nothing to attach to) — just stop re-checking it.
          await paymentTransactionModel.updateOne({ _id: txn._id }, { $set: { stuckAlertSentAt: now } });
          continue;
        }

        const outcome = await this.reconcileSession(storeId, txn.paymentType, txn.providerSessionId, 'stuck-payment check');
        if (outcome === 'paid') { recovered++; continue; }
        if (outcome === 'failed') continue;

        // Still unknown — claim the alert first so a crash/retry never notifies twice.
        const claimed = await paymentTransactionModel.updateOne({ _id: txn._id, stuckAlertSentAt: null }, { $set: { stuckAlertSentAt: now } });
        if (!claimed.modifiedCount) continue;
        const store: any = await storeModel.findById(storeId).select('sellerId name').lean();
        if (!store?.sellerId) continue;
        const gateway = GATEWAY_NAMES[txn.paymentType] ?? txn.paymentType;
        const amount = `${txn.currency ?? 'PKR'} ${Number(txn.amount ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
        await this.notifications.notify({
          recipientId: String(store.sellerId),
          recipientRole: 'seller',
          storeId,
          type: 'payment_unconfirmed',
          title: `${gateway} payment not confirmed`,
          body: `A ${amount} ${gateway} payment (reference ${txn.providerSessionId}) started over an hour ago but ${gateway} never confirmed it, so no order was created. Check this reference in your ${gateway} merchant portal — if the buyer was charged, create the order or refund them there.`,
          data: { checkoutId: String(txn.checkoutId), reference: txn.providerSessionId, gateway: txn.paymentType },
        });
        this.activityLog.log({
          storeId, category: 'integrations', action: 'integration.payment_unconfirmed',
          description: `${gateway} session ${txn.providerSessionId} (${amount}) still unconfirmed after 1 hour — seller notified`,
          actorId: 'system', actorRole: 'system', targetId: String(txn.checkoutId), targetType: 'checkout',
        }).catch(() => undefined);
        alerted++;
      } catch (err: any) {
        // Amount mismatch / finalize failure: leave it for the next run and the security alert the shared checks raise.
        this.logger.warn(`Stuck gateway payment ${String(txn._id)} not processed: ${err?.message ?? err}`);
      }
    }
    return { checked: txns.length, recovered, alerted };
  }
}
