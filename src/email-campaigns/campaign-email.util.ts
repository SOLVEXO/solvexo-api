/* eslint-disable prettier/prettier */
import { escapeHtml, renderMergeTags } from '@/newsletter/marketing-email.util';

export interface CampaignEmailInput {
  subject: string;
  message: string; // seller-authored HTML body with merge tags
  customerName: string;
  storeName: string;
  /** Built with the drag-and-drop editor — the email has its own buttons and
   *  layout, so no automatic "Visit store" button is added. */
  designed?: boolean;
  /** Where the automatic "Visit store" button (non-designed emails) goes. */
  ctaUrl: string | null;
  /** Wraps every http(s) link for click tracking (real sends only). */
  trackLink?: ((href: string) => string) | null;
  openPixelUrl?: string | null;
  unsubscribeUrl?: string | null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Rewrites href="http(s)://…" through `track` (the unsubscribe link and
 *  mailto: are left alone). */
export function trackLinks(html: string, track: (href: string) => string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, href: string) => `href="${escapeHtml(track(decodeEntities(href)))}"`);
}

/** Every http(s) link target present in a campaign's HTML — the allow-list
 *  the click-tracking redirect checks against (no open redirect). */
export function campaignLinkTargets(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of (html ?? '').matchAll(/href="(https?:\/\/[^"]+)"/gi)) out.add(decodeEntities(m[1]));
  return out;
}

/** One place that turns a campaign into the email that's actually sent — used
 *  by the queue processor for real sends and by "Send test email", so a test
 *  looks exactly like what subscribers will get. */
export function renderCampaignEmail(input: CampaignEmailInput): { subject: string; html: string } {
  const vars = { customerName: input.customerName, storeName: input.storeName };
  const subject = renderMergeTags(input.subject, vars);
  let body = renderMergeTags(input.message, vars);
  if (input.trackLink) body = trackLinks(body, input.trackLink);
  const storeName = escapeHtml(input.storeName);

  const footer = input.unsubscribeUrl
    ? `<p style="margin:${input.designed ? '0 auto' : '32px 0 0'};max-width:600px;padding:16px 12px;${input.designed ? '' : 'border-top:1px solid #eee;'}color:#888;font-size:12px;text-align:center;font-family:sans-serif">
          You're receiving this because you subscribed to emails from ${storeName}.<br />
          <a href="${input.unsubscribeUrl}" style="color:#888">Unsubscribe</a>
        </p>` : '';
  const pixel = input.openPixelUrl ? `<img src="${input.openPixelUrl}" width="1" height="1" alt="" style="display:none" />` : '';

  if (input.designed) {
    // The editor's HTML is already a full-width, centred 600px layout.
    return { subject, html: `${body}${footer}${pixel}` };
  }

  const cta = input.ctaUrl ? `<p style="margin-top:24px"><a href="${input.ctaUrl}" style="background:#141413;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Visit ${storeName}</a></p>` : '';
  return {
    subject,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        ${body}
        ${cta}
        ${footer}
        ${pixel}
      </div>`,
  };
}
