/* eslint-disable prettier/prettier */
import { escapeHtml } from '@/newsletter/marketing-email.util';
import { notificationEmailShell, type EmailStoreBrand } from './templates/notification-email.template';

export type TemplateVars = Record<string, string | null | undefined>;

const TAG = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

function tagValue(vars: TemplateVars, name: string): string {
  const v = vars[name];
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Subject line: tags are replaced, an empty tag becomes ''. Single line, capped. */
export function renderSubject(template: string, vars: TemplateVars): string {
  return String(template ?? '')
    .replace(TAG, (_m, name: string) => tagValue(vars, name).replace(/\s+/g, ' '))
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Body: tags are replaced; a line that uses a tag with no value (e.g. "Carrier: {{carrier}}" on a
 *  shipment without a carrier) is dropped so the email never shows a dangling label. */
export function renderBodyText(template: string, vars: TemplateVars): string {
  const lines = String(template ?? '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    let missing = false;
    const rendered = line.replace(TAG, (_m, name: string) => {
      const v = tagValue(vars, name);
      if (!v) missing = true;
      return v;
    });
    if (missing) continue;
    kept.push(rendered);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Plain text → safe HTML paragraphs (everything is escaped; the seller never writes markup). */
export function textToParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function renderCustomerEmail(args: {
  subjectTemplate: string;
  bodyTemplate: string;
  vars: TemplateVars;
  storeName: string;
  brand?: Omit<EmailStoreBrand, 'name'> | null;
  cta?: { label: string; url: string } | null;
}): { subject: string; html: string } {
  const subject = renderSubject(args.subjectTemplate, args.vars) || args.storeName;
  const body = renderBodyText(args.bodyTemplate, args.vars);
  const html = notificationEmailShell(escapeHtml(subject), textToParagraphs(body), args.cta ?? undefined, { name: args.storeName, ...(args.brand ?? {}) });
  return { subject, html };
}
