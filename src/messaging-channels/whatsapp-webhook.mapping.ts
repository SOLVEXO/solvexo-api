/* eslint-disable prettier/prettier */
/**
 * VERIFY AGAINST OFFICIAL DOC (Meta WhatsApp Cloud API webhooks). This is the ONLY place that knows the shape of Meta's webhook payload.
 * Assumed from memory, not checked against a live account or the current docs:
 *   entry[].changes[].value = {
 *     metadata: { phone_number_id },
 *     statuses: [{ id, status: 'sent'|'delivered'|'read'|'failed', recipient_id, errors?: [{ code, title }] }],
 *     messages: [{ from, type: 'text'|'button'|..., text?: { body }, button?: { text, payload } }]
 *   }
 * Anything that does not match is ignored, never an error: Meta still needs a 200.
 */
export interface MappedStatus { id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; recipient: string | null; error: string | null }
export interface MappedInbound { from: string; text: string }

export function mapWhatsAppWebhook(payload: any): { phoneNumberId: string | null; statuses: MappedStatus[]; inbound: MappedInbound[] } {
  const statuses: MappedStatus[] = [];
  const inbound: MappedInbound[] = [];
  let phoneNumberId: string | null = null;
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const e of entries) {
    for (const ch of Array.isArray(e?.changes) ? e.changes : []) {
      const v = ch?.value;
      if (!v || typeof v !== 'object') continue;
      if (typeof v.metadata?.phone_number_id === 'string') phoneNumberId = v.metadata.phone_number_id;
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        if (typeof s?.id !== 'string' || !['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
        const err = Array.isArray(s.errors) && s.errors[0] ? `${s.errors[0].code ?? ''} ${s.errors[0].title ?? ''}`.trim().slice(0, 300) : null;
        statuses.push({ id: s.id, status: s.status, recipient: typeof s.recipient_id === 'string' ? s.recipient_id : null, error: err });
      }
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        if (typeof m?.from !== 'string') continue;
        const text = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text ?? m.button?.payload : null;
        if (typeof text === 'string') inbound.push({ from: m.from, text });
      }
    }
  }
  return { phoneNumberId, statuses, inbound };
}
