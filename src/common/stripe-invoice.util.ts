/* eslint-disable prettier/prettier */
/**
 * Version-tolerant readers for Stripe Invoice objects.
 *
 * Stripe API `2025-03-31.basil` removed `invoice.subscription` and
 * `invoice.payment_intent` (the subscription moved to
 * `invoice.parent.subscription_details.subscription`; payments moved to the
 * `invoice.payments` list, which is NOT included unless expanded). A webhook
 * event's payload is rendered at the API version of its webhook endpoint /
 * the account default — which this codebase does not control — so billing
 * handlers must accept BOTH the legacy and the current shape.
 */

type IdOrObject = string | { id?: string } | null | undefined;

function toId(value: IdOrObject): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return typeof value.id === 'string' ? value.id : undefined;
}

/** The Stripe subscription id an invoice belongs to, or undefined for a non-subscription invoice. */
export function getInvoiceSubscriptionId(invoice: any): string | undefined {
  return (
    toId(invoice?.subscription) ??
    toId(invoice?.parent?.subscription_details?.subscription) ??
    toId(invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription)
  );
}

/**
 * The PaymentIntent id behind an invoice payment, or null when the event
 * doesn't carry it (new API shapes only include it when `payments` is expanded).
 */
export function getInvoicePaymentIntentId(invoice: any): string | null {
  const legacy = toId(invoice?.payment_intent);
  if (legacy) return legacy;
  const payments: any[] = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : [];
  for (const p of payments) {
    const pi = toId(p?.payment?.payment_intent);
    if (pi) return pi;
  }
  return null;
}
