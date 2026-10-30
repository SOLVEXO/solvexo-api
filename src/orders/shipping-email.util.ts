/* eslint-disable prettier/prettier */
import { escapeHtml } from '@/newsletter/marketing-email.util';
import { notificationEmailShell } from '@/notifications/templates/notification-email.template';

export interface PickupInfo { name?: string | null; address?: string | null; instructions?: string | null }
export interface TrackingInfo { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null }

/** First name of whoever the order is for ('' when unknown — the template then says "there"). */
export function orderCustomerName(order: any): string {
  return String(order?.shippingAddress?.recipientName ?? '').trim().split(/\s+/)[0] ?? '';
}

/** The store-template side of a customer email: which event it is and the values for its {{tags}}
 *  (see notifications/customer-email-events.ts). Spread next to the built-in `{ subject, html }`. */
export function customerEmailExtras(
  event: 'order_shipped' | 'order_ready_for_pickup' | 'order_delivered',
  p: { order: any; orderNumber: string; itemLines?: string[]; tracking?: TrackingInfo | null; pickup?: PickupInfo | null; pickedUp?: boolean },
) {
  return {
    event,
    trackingUrl: p.tracking?.trackingUrl ?? null,
    vars: {
      customerName: orderCustomerName(p.order),
      orderNumber: p.orderNumber,
      itemList: (p.itemLines ?? []).join('\n'),
      carrier: p.tracking?.carrier ?? null,
      trackingNumber: p.tracking?.trackingNumber ?? null,
      pickupLocation: p.pickup?.name ?? null,
      pickupAddress: p.pickup?.address ?? null,
      pickupInstructions: p.pickup?.instructions ?? null,
      deliveryStatus: p.pickedUp ? 'picked up' : 'delivered',
    },
  } as const;
}

function detailRows(rows: [string, string | null | undefined][]): string {
  const body = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">${escapeHtml(k)}</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${escapeHtml(String(v))}</td></tr></table>`)
    .join('');
  return body ? `<div class="box">${body}</div>` : '';
}

/** Email for "your order (or part of it) has shipped" — carrier, tracking number, tracking link. */
export function buildShippedEmail(p: { storeName: string; orderNumber: string; tracking?: TrackingInfo | null; partial?: boolean; items?: string[] }) {
  const title = p.partial ? 'Part of your order has shipped' : 'Your order has shipped';
  const url = p.tracking?.trackingUrl && /^https?:\/\//i.test(p.tracking.trackingUrl) ? p.tracking.trackingUrl : null;
  const itemList = p.items && p.items.length ? `<p>${p.items.map((i) => escapeHtml(i)).join('<br>')}</p>` : '';
  const html = notificationEmailShell(
    escapeHtml(title),
    `<h1>${escapeHtml(title)}</h1><p>Good news from ${escapeHtml(p.storeName)} — order #${escapeHtml(p.orderNumber)} is on its way.</p>${itemList}` +
      detailRows([['Carrier', p.tracking?.carrier], ['Tracking number', p.tracking?.trackingNumber]]),
    url ? { label: 'Track your package', url } : undefined,
    p.storeName,
  );
  return { subject: `${title} — order #${p.orderNumber} from ${p.storeName}`, html };
}

/** Email for local pickup: the order is ready to collect. */
export function buildReadyForPickupEmail(p: { storeName: string; orderNumber: string; pickup?: PickupInfo | null }) {
  const html = notificationEmailShell(
    'Your order is ready for pickup',
    `<h1>Your order is ready for pickup</h1><p>Order #${escapeHtml(p.orderNumber)} from ${escapeHtml(p.storeName)} is ready to collect.</p>` +
      detailRows([['Pickup location', p.pickup?.name], ['Address', p.pickup?.address], ['Instructions', p.pickup?.instructions]]),
    undefined,
    p.storeName,
  );
  return { subject: `Your order #${p.orderNumber} is ready for pickup — ${p.storeName}`, html };
}

export function buildDeliveredEmail(p: { storeName: string; orderNumber: string; pickedUp?: boolean }) {
  const title = p.pickedUp ? 'Your order was picked up' : 'Your order was delivered';
  const html = notificationEmailShell(
    escapeHtml(title),
    `<h1>${escapeHtml(title)}</h1><p>Order #${escapeHtml(p.orderNumber)} from ${escapeHtml(p.storeName)} is complete. Thank you for shopping with us.</p>`,
    undefined,
    p.storeName,
  );
  return { subject: `${title} — order #${p.orderNumber}`, html };
}

/** Email for "a return label is ready" — the prepaid label to print and the carrier tracking. */
export function buildReturnLabelEmail(p: { storeName: string; orderNumber: string; labelUrl?: string | null; carrier?: string | null; trackingNumber?: string | null; items?: string[] }) {
  const title = 'Your return label is ready';
  const url = p.labelUrl && /^https?:\/\//i.test(p.labelUrl) ? p.labelUrl : null;
  const itemList = p.items && p.items.length ? `<p>${p.items.map((i) => escapeHtml(i)).join('<br>')}</p>` : '';
  const html = notificationEmailShell(
    escapeHtml(title),
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(p.storeName)} approved your return for order #${escapeHtml(p.orderNumber)}. Print the prepaid label, attach it to the package and drop it off with the carrier.</p>${itemList}` +
      detailRows([['Carrier', p.carrier], ['Tracking number', p.trackingNumber]]),
    url ? { label: 'Download return label', url } : undefined,
    p.storeName,
  );
  return { subject: `${title} — order #${p.orderNumber} from ${p.storeName}`, html };
}
