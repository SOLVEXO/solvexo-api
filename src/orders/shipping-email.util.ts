/* eslint-disable prettier/prettier */
import { escapeHtml } from '@/newsletter/marketing-email.util';
import { notificationEmailShell } from '@/notifications/templates/notification-email.template';

export interface PickupInfo { name?: string | null; address?: string | null; instructions?: string | null }
export interface TrackingInfo { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null }

function detailRows(rows: [string, string | null | undefined][]): string {
  const body = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="row"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>`)
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
  );
  return { subject: `${title} — order #${p.orderNumber} from ${p.storeName}`, html };
}

/** Email for local pickup: the order is ready to collect. */
export function buildReadyForPickupEmail(p: { storeName: string; orderNumber: string; pickup?: PickupInfo | null }) {
  const html = notificationEmailShell(
    'Your order is ready for pickup',
    `<h1>Your order is ready for pickup</h1><p>Order #${escapeHtml(p.orderNumber)} from ${escapeHtml(p.storeName)} is ready to collect.</p>` +
      detailRows([['Pickup location', p.pickup?.name], ['Address', p.pickup?.address], ['Instructions', p.pickup?.instructions]]),
  );
  return { subject: `Your order #${p.orderNumber} is ready for pickup — ${p.storeName}`, html };
}

export function buildDeliveredEmail(p: { storeName: string; orderNumber: string; pickedUp?: boolean }) {
  const title = p.pickedUp ? 'Your order was picked up' : 'Your order was delivered';
  const html = notificationEmailShell(
    escapeHtml(title),
    `<h1>${escapeHtml(title)}</h1><p>Order #${escapeHtml(p.orderNumber)} from ${escapeHtml(p.storeName)} is complete. Thank you for shopping with us.</p>`,
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
  );
  return { subject: `${title} — order #${p.orderNumber} from ${p.storeName}`, html };
}
