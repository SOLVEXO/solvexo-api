/* eslint-disable prettier/prettier */

/**
 * WhatsApp Cloud API helpers for Solvexo's own sales number. Pure functions; SalesWhatsAppService does the I/O.
 *
 * Meta's rule that shapes the inbox: a business may send free-form messages only within 24 hours of the person's
 * last message ("customer service window"). Outside it, only an approved template message can start the chat again.
 */

export const WINDOW_MS = 24 * 3_600_000;

export interface InboundMessage {
  waMessageId: string;
  from: string;
  name: string | null;
  type: string;
  text: string;
  at: Date;
}
export interface StatusUpdate {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error: string | null;
  at: Date;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** A readable line for any inbound message type (media are not downloaded; the inbox says what arrived). */
function textOf(m: any): string {
  switch (m?.type) {
    case 'text':
      return str(m.text?.body) ?? '';
    case 'button':
      return str(m.button?.text) ?? '[Button]';
    case 'interactive':
      return (
        str(m.interactive?.button_reply?.title) ??
        str(m.interactive?.list_reply?.title) ??
        '[Reply]'
      );
    case 'image':
    case 'video':
    case 'document': {
      const caption = str(m[m.type]?.caption) ?? str(m.document?.filename);
      return `[${m.type[0].toUpperCase()}${m.type.slice(1)}]${caption ? ` ${caption}` : ''}`;
    }
    case 'audio':
      return '[Voice message]';
    case 'sticker':
      return '[Sticker]';
    case 'location':
      return `[Location]${m.location?.name ? ` ${m.location.name}` : ''}`;
    case 'contacts':
      return '[Contact card]';
    case 'reaction':
      return `[Reacted ${str(m.reaction?.emoji) ?? ''}]`;
    default:
      return `[${str(m?.type) ?? 'Message'}]`;
  }
}

/** Every message and status in a webhook payload that belongs to `phoneNumberId`. */
export function parseWebhook(
  payload: any,
  phoneNumberId: string,
): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = change?.value;
      if (str(v?.metadata?.phone_number_id) !== phoneNumberId) continue;
      const names = new Map<string, string>(
        (Array.isArray(v?.contacts) ? v.contacts : [])
          .filter((c: any) => str(c?.wa_id))
          .map((c: any) => [c.wa_id, str(c?.profile?.name) ?? '']),
      );
      for (const m of Array.isArray(v?.messages) ? v.messages : []) {
        const id = str(m?.id),
          from = str(m?.from);
        if (!id || !from || !/^\d{6,20}$/.test(from)) continue;
        messages.push({
          waMessageId: id,
          from,
          name: names.get(from) || null,
          type: str(m.type) ?? 'unknown',
          text: textOf(m).slice(0, 4000),
          at: new Date((Number(m.timestamp) || Date.now() / 1000) * 1000),
        });
      }
      for (const s of Array.isArray(v?.statuses) ? v.statuses : []) {
        const id = str(s?.id),
          st = str(s?.status);
        if (!id || !st || !['sent', 'delivered', 'read', 'failed'].includes(st))
          continue;
        const err =
          Array.isArray(s.errors) && s.errors[0]
            ? `${s.errors[0].title ?? ''}${s.errors[0].error_data?.details ? `: ${s.errors[0].error_data.details}` : ''}`.trim()
            : null;
        statuses.push({
          waMessageId: id,
          status: st as StatusUpdate['status'],
          error: err || null,
          at: new Date((Number(s.timestamp) || Date.now() / 1000) * 1000),
        });
      }
    }
  }
  return { messages, statuses };
}

/** Can a free-form message be sent now? */
export const windowOpen = (
  lastInboundAt: Date | string | null | undefined,
  now = Date.now(),
) => !!lastInboundAt && now - new Date(lastInboundAt).getTime() < WINDOW_MS;

/** WhatsApp wants international digits: 0300 1234567 → 923001234567 (Pakistan numbers written locally). */
export function toWaId(phone: string | null | undefined): string | null {
  let d = (phone ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = `92${d.slice(1)}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** Status only moves forward (a late "delivered" never overwrites "read"); "failed" always sticks. */
const RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};
export function nextStatus(current: string, incoming: string): string {
  if (incoming === 'failed') return 'failed';
  if (current === 'failed') return current;
  return (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : current;
}
