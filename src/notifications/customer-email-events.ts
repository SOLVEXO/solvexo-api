/* eslint-disable prettier/prettier */

/**
 * The customer-facing emails a STORE sends (Shopify: Settings → Notifications → Customer notifications).
 * Each event has a default subject/message, the merge tags a seller may use, and an on/off switch.
 * Everything a seller can edit is plain text + {{tags}} — never HTML — so a template can't break the layout
 * or inject markup (see customer-email-template.util.ts).
 */
export const CUSTOMER_EMAIL_EVENTS = [
  'order_confirmation',
  'order_shipped',
  'order_ready_for_pickup',
  'order_delivered',
  'order_cancelled',
  'order_refunded',
  'order_edited',
  'return_update',
  'review_request',
  'draft_order_invoice',
  'draft_order_overdue',
  'gift_card',
  'gift_card_updated',
  'gift_card_sent',
  'digital_purchase_delivered',
  'digital_file_updated',
  'membership_welcome',
  'membership_renewal_reminder',
  'membership_payment_failed',
  'membership_grace_period',
  'membership_cancelled',
  'membership_expired',
] as const;

export type CustomerEmailEvent = (typeof CUSTOMER_EMAIL_EVENTS)[number];

export type CustomerEmailGroup = 'orders' | 'returns' | 'invoices' | 'digital';

export interface CustomerEmailEventDef {
  /** Where the email is listed on the seller's Customer emails page. */
  group: CustomerEmailGroup;
  label: string;
  description: string;
  defaultSubject: string;
  defaultBody: string;
  /** Merge tags this event can fill — a template using any other tag is rejected on save. */
  variables: string[];
  /** Events that can be resent from the order page. */
  resendable: boolean;
  /** false = always sent (the seller triggers it by hand, or it carries the only copy of something). Default true. */
  canDisable?: boolean;
  /** false = off until the seller switches it on (marketing-style emails). Default true. */
  defaultEnabled?: boolean;
}

const COMMON = ['storeName', 'customerName', 'orderNumber', 'orderUrl'];

export const CUSTOMER_EMAIL_CATALOG: Record<CustomerEmailEvent, CustomerEmailEventDef> = {
  order_confirmation: {
    group: 'orders',
    label: 'Order confirmation',
    description: 'Sent to the customer as soon as they place an order.',
    defaultSubject: 'Your order from {{storeName}} is confirmed',
    defaultBody:
      'Hi {{customerName}},\n\nThanks for your order! Order {{orderNumber}} from {{storeName}} is confirmed.\n\n{{itemList}}\n\nSubtotal: {{subtotal}}\nShipping: {{shipping}}\nTax: {{tax}}\nTotal: {{total}}\n\nQuestions about this order? Just reply to this email.',
    variables: [...COMMON, 'itemList', 'subtotal', 'shipping', 'tax', 'total'],
    resendable: true,
  },
  order_shipped: {
    group: 'orders',
    label: 'Shipping confirmation',
    description: 'Sent when you mark an order (or part of it) as shipped.',
    defaultSubject: 'Your order #{{orderNumber}} from {{storeName}} has shipped',
    defaultBody:
      'Hi {{customerName}},\n\nGood news! Order #{{orderNumber}} from {{storeName}} is on its way.\n\n{{itemList}}\n\nCarrier: {{carrier}}\nTracking number: {{trackingNumber}}',
    variables: [...COMMON, 'itemList', 'carrier', 'trackingNumber', 'trackingUrl'],
    resendable: true,
  },
  order_ready_for_pickup: {
    group: 'orders',
    label: 'Ready for pickup',
    description: 'Sent when a local-pickup order is ready to collect.',
    defaultSubject: 'Your order #{{orderNumber}} is ready for pickup — {{storeName}}',
    defaultBody:
      'Hi {{customerName}},\n\nYour order #{{orderNumber}} from {{storeName}} is ready to collect.\n\nPickup location: {{pickupLocation}}\nAddress: {{pickupAddress}}\nInstructions: {{pickupInstructions}}',
    variables: [...COMMON, 'pickupLocation', 'pickupAddress', 'pickupInstructions'],
    resendable: true,
  },
  order_delivered: {
    group: 'orders',
    label: 'Delivered',
    description: 'Sent when an order is marked delivered (or picked up).',
    defaultSubject: 'Your order #{{orderNumber}} has been {{deliveryStatus}} — {{storeName}}',
    defaultBody:
      'Hi {{customerName}},\n\nOrder #{{orderNumber}} from {{storeName}} has been {{deliveryStatus}}. Thank you for shopping with us.',
    variables: [...COMMON, 'deliveryStatus'],
    resendable: true,
  },
  review_request: {
    group: 'orders',
    label: 'Review request',
    description: 'Sent a few days after an order is delivered, asking the customer to review what they bought. Off until you switch it on.',
    defaultSubject: 'How was your order from {{storeName}}?',
    defaultBody:
      'Hi {{customerName}},\n\nYour order #{{orderNumber}} from {{storeName}} arrived a few days ago. We would love to hear what you think.\n\n{{itemList}}\n\nA short review helps other shoppers and means a lot to us.',
    variables: [...COMMON, 'itemList', 'reviewUrl'],
    resendable: false,
    defaultEnabled: false,
  },
  order_cancelled: {
    group: 'orders',
    label: 'Order canceled',
    description: 'Sent when you cancel an order (or items in it).',
    defaultSubject: 'Your order #{{orderNumber}} from {{storeName}} was canceled',
    defaultBody:
      'Hi {{customerName}},\n\nOrder #{{orderNumber}} from {{storeName}} has been canceled.\n\n{{itemList}}\n\nIf a refund is due you will receive a separate refund email. Questions? Just reply to this email.',
    variables: [...COMMON, 'itemList'],
    resendable: true,
  },
  order_refunded: {
    group: 'orders',
    label: 'Refund',
    description: 'Sent when you refund an order or a return.',
    defaultSubject: 'Refund for order #{{orderNumber}} from {{storeName}}',
    defaultBody:
      'Hi {{customerName}},\n\nWe have refunded {{refundAmount}} for order #{{orderNumber}} from {{storeName}}.\n\nRefund method: {{refundMethod}}\n\nQuestions? Just reply to this email.',
    variables: [...COMMON, 'refundAmount', 'refundMethod'],
    resendable: true,
  },
  order_edited: {
    group: 'orders',
    label: 'Order edited',
    description: 'Sent when you change an order after it was placed (items, quantities or price).',
    defaultSubject: 'Your order #{{orderNumber}} from {{storeName}} was updated',
    defaultBody:
      'Hi {{customerName}},\n\n{{storeName}} updated order #{{orderNumber}}.\n\nNew total: {{newTotal}}\n{{changeNote}}\n\nQuestions? Just reply to this email.',
    variables: [...COMMON, 'newTotal', 'changeNote'],
    resendable: false,
  },
  return_update: {
    group: 'returns',
    label: 'Return & exchange updates',
    description: 'Sent when a return is approved, declined, received or closed, and when an exchange is created.',
    defaultSubject: '{{updateTitle}} — order #{{orderNumber}} from {{storeName}}',
    defaultBody:
      'Hi {{customerName}},\n\n{{updateTitle}}\n{{updateMessage}}\n\nOrder #{{orderNumber}} from {{storeName}}.\nQuestions? Just reply to this email.',
    variables: [...COMMON, 'updateTitle', 'updateMessage'],
    resendable: false,
  },
  draft_order_invoice: {
    group: 'invoices',
    label: 'Draft order invoice',
    description: 'Sent when you email an invoice for a draft order with a link to pay it.',
    defaultSubject: 'Invoice from {{storeName}} — {{invoiceTotal}}',
    defaultBody:
      'Hi {{customerName}},\n\nYou have a new invoice from {{storeName}} for {{invoiceTotal}}.\n{{dueText}}\n\nUse the button below to pay it securely online.',
    variables: ['storeName', 'customerName', 'invoiceTotal', 'dueText', 'invoiceUrl'],
    resendable: false,
    canDisable: false,
  },
  draft_order_overdue: {
    group: 'invoices',
    label: 'Overdue invoice reminder',
    description: 'Sent automatically when a draft-order invoice is still unpaid after its due date.',
    defaultSubject: 'Overdue invoice from {{storeName}} — {{invoiceTotal}}',
    defaultBody:
      'Hi {{customerName}},\n\nYour invoice from {{storeName}} for {{invoiceTotal}} was due by {{dueDate}} and is still unpaid.\n\nUse the button below to pay it securely online.',
    variables: ['storeName', 'customerName', 'invoiceTotal', 'dueDate', 'invoiceUrl'],
    resendable: false,
  },
  gift_card: {
    group: 'invoices',
    label: 'Gift card',
    description: 'Sent to the person who receives a gift card from your store.',
    defaultSubject: "You've received a {{giftCardValue}} gift card from {{storeName}}",
    defaultBody:
      "Hi {{customerName}},\n\nYou've received a gift card for {{storeName}}.\n\n{{giftCardMessage}}\n\nYour code: {{giftCardCode}}\nValue: {{giftCardValue}}\n\nEnter this code at checkout on {{storeName}} to redeem it.",
    variables: ['storeName', 'customerName', 'giftCardValue', 'giftCardCode', 'giftCardMessage'],
    resendable: false,
    canDisable: false,
  },
  gift_card_updated: {
    group: 'invoices',
    label: 'Gift card updated',
    description: 'Sent when you change a gift card\'s balance or disable it and choose to let the recipient know.',
    defaultSubject: 'Your {{storeName}} gift card was updated',
    defaultBody:
      'Hi {{customerName}},\n\nYour gift card for {{storeName}} was updated.\n\n{{giftCardChange}}\n{{giftCardReason}}\n\nGift card code: {{giftCardCode}}\nBalance now: {{giftCardBalance}}',
    variables: ['storeName', 'customerName', 'giftCardCode', 'giftCardBalance', 'giftCardChange', 'giftCardReason'],
    resendable: false,
  },
  gift_card_sent: {
    group: 'invoices',
    label: 'Gift card sent (to the buyer)',
    description: 'Sent to the customer who bought a gift card for someone else, to confirm it was delivered. The code itself goes only to the recipient.',
    defaultSubject: 'Your gift card from {{storeName}} was sent',
    defaultBody:
      'Hi {{customerName}},\n\nThanks for your purchase! Your {{giftCardValue}} gift card from {{storeName}} {{giftCardDelivery}}.\n\nIf they cannot find it, ask them to check their spam folder or contact us and we will send it again.',
    variables: ['storeName', 'customerName', 'giftCardValue', 'giftCardDelivery'],
    resendable: false,
  },
  digital_purchase_delivered: {
    group: 'digital',
    label: "Digital purchase ready",
    description: "Sent when a digital purchase is paid and the downloads are ready in the customer's library.",
    defaultSubject: "Your downloads from {{storeName}} are ready",
    defaultBody:
      "Hi {{customerName}},\n\nThanks for your purchase! {{productName}} is ready to download from your library:\n{{libraryUrl}}\n\nIf you have trouble, just reply to this email.",
    variables: ["storeName","customerName","productName","libraryUrl"],
    resendable: false,
  },
  digital_file_updated: {
    group: 'digital',
    label: "Digital file updated",
    description: "Sent to buyers when a new version of a file they own is published.",
    defaultSubject: "{{productName}} was updated",
    defaultBody:
      "Hi {{customerName}},\n\nA new version ({{versionLabel}}) of {{fileName}} in {{productName}} is available.\n{{changelog}}\n\nDownload it from your library:\n{{libraryUrl}}",
    variables: ["storeName","customerName","productName","fileName","versionLabel","changelog","libraryUrl"],
    resendable: false,
    defaultEnabled: true,
  },
  membership_welcome: {
    group: 'digital',
    label: "Membership welcome",
    description: "Sent when a customer joins a membership plan.",
    defaultSubject: "Welcome to {{planName}}",
    defaultBody:
      "Hi {{customerName}},\n\nWelcome to {{planName}} at {{storeName}}! You can manage your membership here:\n{{membershipUrl}}",
    variables: ["storeName","customerName","planName","membershipUrl"],
    resendable: false,
  },
  membership_renewal_reminder: {
    group: 'digital',
    label: "Membership renewal reminder",
    description: "Sent about 7 days before a membership renews.",
    defaultSubject: "Your {{planName}} renews soon",
    defaultBody:
      "Hi {{customerName}},\n\nYour {{planName}} membership at {{storeName}} renews on {{renewalDate}}.\nManage it here:\n{{membershipUrl}}",
    variables: ["storeName","customerName","planName","renewalDate","membershipUrl"],
    resendable: false,
  },
  membership_payment_failed: {
    group: 'digital',
    label: "Membership payment due",
    description: "Sent when a membership payment has not been received.",
    defaultSubject: "Payment needed for {{planName}}",
    defaultBody:
      "Hi {{customerName}},\n\nWe have not received the payment for your {{planName}} membership at {{storeName}}. Please complete it to keep your access.\n{{membershipUrl}}",
    variables: ["storeName","customerName","planName","membershipUrl"],
    resendable: false,
  },
  membership_grace_period: {
    group: 'digital',
    label: "Membership grace period",
    description: "Sent while a past-due membership is still within its grace period.",
    defaultSubject: "Your {{planName}} access is about to end",
    defaultBody:
      "Hi {{customerName}},\n\nYour payment for {{planName}} at {{storeName}} is still outstanding. Your access continues for a short time. Please pay to avoid losing it.\n{{membershipUrl}}",
    variables: ["storeName","customerName","planName","membershipUrl"],
    resendable: false,
  },
  membership_cancelled: {
    group: 'digital',
    label: "Membership cancelled",
    description: "Sent when a membership ends because it was cancelled.",
    defaultSubject: "Your {{planName}} membership has ended",
    defaultBody:
      "Hi {{customerName}},\n\nYour {{planName}} membership at {{storeName}} has ended. You can rejoin any time:\n{{membershipUrl}}",
    variables: ["storeName","customerName","planName","membershipUrl"],
    resendable: false,
  },
  membership_expired: {
    group: 'digital',
    label: "Membership expired",
    description: "Sent when a membership expires (unpaid or fixed length reached).",
    defaultSubject: "Your {{planName}} membership expired",
    defaultBody:
      "Hi {{customerName}},\n\nYour {{planName}} membership at {{storeName}} has expired. To get your access back, renew here:\n{{membershipUrl}}",
    variables: ["storeName","customerName","planName","membershipUrl"],
    resendable: false,
  },
};

export function isCustomerEmailEvent(value: unknown): value is CustomerEmailEvent {
  return typeof value === 'string' && (CUSTOMER_EMAIL_EVENTS as readonly string[]).includes(value);
}

/** Merge tags a piece of template text uses (`{{name}}`). */
export function templateTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

/** Sample values used by the Preview button. */
export const CUSTOMER_EMAIL_SAMPLE_VARS: Record<string, string> = {
  customerName: 'Alex',
  orderNumber: '1001',
  orderUrl: 'https://example.com/order-status/sample',
  itemList: 'Classic T-shirt × 2\nCanvas tote × 1',
  subtotal: 'Rs 4,500.00',
  shipping: 'Rs 200.00',
  tax: 'Rs 0.00',
  total: 'Rs 4,700.00',
  carrier: 'TCS',
  trackingNumber: 'TRK123456789',
  trackingUrl: 'https://example.com/track/TRK123456789',
  pickupLocation: 'Main store',
  pickupAddress: '12 Market Road, Karachi',
  pickupInstructions: 'Bring your order number',
  deliveryStatus: 'delivered',
  reviewUrl: 'https://example.com/orders/sample',
  refundAmount: 'Rs 1,200.00',
  refundMethod: 'Original payment method',
  newTotal: 'Rs 4,200.00',
  changeNote: 'One item was removed.',
  updateTitle: 'Your return was approved',
  updateMessage: 'Please send the item back using the label we emailed you.',
  invoiceTotal: 'Rs 12,000.00',
  dueText: 'Payment is due by 30 Oct 2026.',
  dueDate: '30 Oct 2026',
  invoiceUrl: 'https://example.com/pay-invoice/sample',
  giftCardValue: 'PKR 5,000',
  giftCardCode: 'GCB35B-4C5736',
  giftCardMessage: 'Happy birthday!',
  giftCardDelivery: 'was emailed to friend@example.com',
  giftCardBalance: 'PKR 2,000',
  giftCardChange: 'The balance changed from PKR 5,000 to PKR 2,000.',
  giftCardReason: 'Note from the store: Correction.',
  productName: 'Brand Kit',
  libraryUrl: 'https://example.com/library',
  fileName: 'brand-kit.zip',
  versionLabel: '2.0',
  changelog: 'What is new: fixed icons.',
  planName: 'Gold',
  membershipUrl: 'https://example.com/memberships',
  renewalDate: '30 Oct 2026',
};
