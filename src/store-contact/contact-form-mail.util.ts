/* eslint-disable prettier/prettier */
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import { textToParagraphs } from '../notifications/customer-email-template.util';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Fills {{name}}, {{store}} and {{form}} in the seller's own text. Unknown tags are left out, never executed. */
export function fillContactTags(text: string, vars: { name: string; store: string; form: string }): string {
  return text.replace(/\{\{\s*(name|store|form)\s*\}\}/gi, (_m, k: string) => (vars as Record<string, string>)[k.toLowerCase()] ?? '');
}

export const DEFAULT_AUTO_REPLY_SUBJECT = 'We got your message';
export const DEFAULT_AUTO_REPLY_BODY = 'Hi {{name}},\n\nThanks for contacting {{store}}. We received your message and will get back to you soon.';

/** The email a store owner gets with EVERY answer of a form. All visitor text is escaped. */
export function buildSellerNotification(opts: {
  storeName: string; logoUrl?: string | null; formName: string; who: string;
  rows: { label: string; value: string }[]; inboxUrl: string;
}): { subject: string; html: string } {
  const form = opts.formName || 'Contact form';
  const table = `<table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 4px;">${opts.rows.map(r =>
    `<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666;font-size:13px;vertical-align:top;width:35%;">${escapeHtml(r.label)}</td><td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;">${escapeHtml(r.value).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>`;
  const html = notificationEmailShell(
    escapeHtml(`New message: ${form}`),
    `<p>${escapeHtml(opts.who)} sent a message through <strong>${escapeHtml(form)}</strong>.</p>${table}`,
    { label: 'Open Contact Messages', url: opts.inboxUrl },
    { name: opts.storeName, logoUrl: opts.logoUrl ?? null },
  );
  return { subject: `${form}: new message from ${opts.who}`.slice(0, 150), html };
}

/** The automatic reply the visitor gets (the seller's text, or a plain default). Subject is plain text, body is escaped. */
export function buildAutoReply(opts: {
  storeName: string; logoUrl?: string | null; formName: string; name: string; subject?: string; body?: string;
}): { subject: string; html: string } {
  const vars = { name: opts.name || 'there', store: opts.storeName, form: opts.formName || 'contact form' };
  const subject = fillContactTags((opts.subject || '').trim() || DEFAULT_AUTO_REPLY_SUBJECT, vars).slice(0, 150);
  const body = fillContactTags((opts.body || '').trim() || DEFAULT_AUTO_REPLY_BODY, vars);
  const html = notificationEmailShell(escapeHtml(subject), textToParagraphs(body), undefined, { name: opts.storeName, logoUrl: opts.logoUrl ?? null, hideReceivingNotice: true });
  return { subject, html };
}

// ── CSV export ──────────────────────────────────────────────────────────────

/** A cell that a spreadsheet could run as a formula is made harmless; quotes and commas are escaped. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const MAX_EXPORT_ROWS = 5000;
const MAX_EXPORT_COLUMNS = 60;

/** Date, form, sender, status, the message, then one column per question (the union over all rows, in first-seen order). */
export function contactMessagesToCsv(rows: any[]): string {
  const questions: string[] = [];
  for (const r of rows) {
    for (const f of r.fields ?? []) {
      if (['name', 'email', 'phone'].includes(f.type)) continue;
      if (!questions.includes(f.label) && questions.length < MAX_EXPORT_COLUMNS) questions.push(f.label);
    }
  }
  const head = ['Date', 'Form', 'Name', 'Email', 'Phone', 'Status', 'Message', ...questions];
  const lines = [head.map(csvCell).join(',')];
  for (const r of rows) {
    const byLabel = new Map<string, string>();
    for (const f of r.fields ?? []) if (!byLabel.has(f.label)) byLabel.set(f.label, f.value);
    const cells = [
      r.createdAt ? new Date(r.createdAt).toISOString() : '', r.formName || '', r.name || '', r.email || '', r.phone || '', r.status || '', r.message || '',
      ...questions.map(q => byLabel.get(q) ?? ''),
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
