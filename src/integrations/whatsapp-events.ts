/* eslint-disable prettier/prettier */

/**
 * Order events a store can send to its customers over its own WhatsApp Business number, each with its own
 * on/off switch and its own (Meta-approved) template. Stored on `StoreIntegration.config.notifications`.
 */
export const WHATSAPP_EVENTS = ['order_confirmed', 'order_cancelled', 'order_refunded', 'order_shipped', 'order_delivered'] as const;
export type WhatsAppEvent = (typeof WHATSAPP_EVENTS)[number];

/** Values a template body variable ({{1}}, {{2}}...) can be mapped to. */
export const WHATSAPP_PARAM_TOKENS = [
  'order_id', 'order_number', 'customer_name', 'store_name', 'total', 'currency', 'carrier', 'tracking_number', 'refund_amount',
] as const;
export type WhatsAppParamToken = (typeof WHATSAPP_PARAM_TOKENS)[number];

export interface WhatsAppEventSettings {
  enabled: boolean;
  templateName: string;
  languageCode: string;
  /** Ordered: element 0 fills {{1}}, element 1 fills {{2}}... */
  params: WhatsAppParamToken[];
}

export type WhatsAppEventVars = Partial<Record<WhatsAppParamToken, string | number | null | undefined>>;

// Shipped/delivered were always sent (when WhatsApp is connected) with exactly these templates — keep that
// behaviour as the default; the three new events are OFF until the seller turns them on.
export const DEFAULT_WHATSAPP_EVENT_SETTINGS: Record<WhatsAppEvent, WhatsAppEventSettings> = {
  order_confirmed: { enabled: false, templateName: 'order_confirmation', languageCode: 'en_US', params: ['order_number', 'store_name', 'total'] },
  order_cancelled: { enabled: false, templateName: 'order_cancelled', languageCode: 'en_US', params: ['order_number'] },
  order_refunded: { enabled: false, templateName: 'order_refunded', languageCode: 'en_US', params: ['order_number', 'refund_amount'] },
  order_shipped: { enabled: true, templateName: 'order_shipped', languageCode: 'en_US', params: ['order_id', 'carrier'] },
  order_delivered: { enabled: true, templateName: 'order_delivered', languageCode: 'en_US', params: ['order_id'] },
};

export function isWhatsAppEvent(v: unknown): v is WhatsAppEvent {
  return typeof v === 'string' && (WHATSAPP_EVENTS as readonly string[]).includes(v);
}

/** Stored overrides merged over the defaults; garbage in storage never breaks a send. */
export function resolveWhatsAppEventSettings(config: Record<string, any> | undefined, event: WhatsAppEvent): WhatsAppEventSettings {
  const base = DEFAULT_WHATSAPP_EVENT_SETTINGS[event];
  const stored = config?.notifications?.[event];
  if (!stored || typeof stored !== 'object') return { ...base, params: [...base.params] };
  const params = Array.isArray(stored.params)
    ? (stored.params.filter((p: unknown) => (WHATSAPP_PARAM_TOKENS as readonly string[]).includes(p as string)) as WhatsAppParamToken[])
    : base.params;
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : base.enabled,
    templateName: typeof stored.templateName === 'string' && stored.templateName ? stored.templateName : base.templateName,
    languageCode: typeof stored.languageCode === 'string' && stored.languageCode ? stored.languageCode : base.languageCode,
    params: [...params],
  };
}

/** Body parameters in template order; a value the caller did not supply becomes "-" (Meta rejects empty parameters). */
export function buildWhatsAppBodyParams(params: WhatsAppParamToken[], vars: WhatsAppEventVars): string[] {
  return params.map((token) => {
    const v = vars[token];
    return v === undefined || v === null || String(v).trim() === '' ? '-' : String(v);
  });
}

/** Digits only, as the Cloud API wants (country code included, no "+", spaces or dashes). */
export function normalizeWhatsAppRecipient(phone: string): string {
  return String(phone ?? '').replace(/\D/g, '');
}
