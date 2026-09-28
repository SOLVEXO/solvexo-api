/* eslint-disable prettier/prettier */

/** Shared building blocks for every store-branded marketing/automation email
 *  (welcome, back-in-stock, price-drop, win-back, admin broadcast) so they all
 *  carry the same footer — who is sending, why, and how to unsubscribe. */

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A store's public storefront origin — its verified custom domain, else its
 *  `<slug>.solvexo.store` subdomain (see main.ts's CORS origin rules). */
export function storePublicUrl(store: { slug?: string; customDomain?: string | null; customDomainStatus?: string } | null | undefined): string | null {
  if (!store) return null;
  if (store.customDomain && store.customDomainStatus === 'verified') return `https://${store.customDomain}`;
  return store.slug ? `https://${store.slug}.solvexo.store` : null;
}

export function renderMergeTags(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((text, [key, val]) => text.split(`{{${key}}}`).join(val), template ?? '');
}

/** Seller-authored plain text → safe HTML paragraphs. Automation messages are
 *  edited in a textarea, not an HTML editor, so they're escaped first. */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br />')}</p>`)
    .join('');
}

export interface MarketingEmailInput {
  senderName: string;
  heading?: string;
  bodyHtml: string;
  cta?: { url: string; label: string } | null;
  /** e.g. a discount code block or a product card, rendered under the body. */
  extraHtml?: string;
  /** Why the recipient is getting this — shown in the footer. */
  reason: string;
  unsubscribeUrl?: string | null;
}

export function renderMarketingEmail(input: MarketingEmailInput): string {
  const sender = escapeHtml(input.senderName);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px 12px;background:#f6f5f2;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#2b2a27;line-height:1.6">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:36px 32px">
    <p style="margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8b8985">${sender}</p>
    ${input.heading ? `<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:#141413">${escapeHtml(input.heading)}</h1>` : ''}
    <div style="font-size:15px">${input.bodyHtml}</div>
    ${input.extraHtml ?? ''}
    ${input.cta ? `<p style="margin:28px 0 0"><a href="${input.cta.url}" style="background:#141413;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:600">${escapeHtml(input.cta.label)}</a></p>` : ''}
    <p style="margin:36px 0 0;padding-top:16px;border-top:1px solid #eeeeee;color:#8b8985;font-size:12px;text-align:center">
      ${escapeHtml(input.reason)}
      ${input.unsubscribeUrl ? `<br /><a href="${input.unsubscribeUrl}" style="color:#8b8985">Unsubscribe</a>` : ''}
    </p>
  </div>
</body>
</html>`;
}

export function discountCodeHtml(code: string): string {
  return `<div style="margin:24px 0 0;padding:16px;border:1px dashed #d6d3cc;border-radius:8px;text-align:center">
    <p style="margin:0 0 4px;font-size:12px;color:#8b8985;text-transform:uppercase;letter-spacing:.05em">Your code</p>
    <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:.08em;color:#141413">${escapeHtml(code)}</p>
  </div>`;
}

export function productCardHtml(p: { name: string; imageUrl?: string | null; priceLine?: string | null }): string {
  return `<div style="margin:24px 0 0;padding:16px;border:1px solid #eeeeee;border-radius:8px">
    ${p.imageUrl ? `<img src="${p.imageUrl}" alt="" width="120" style="display:block;max-width:120px;border-radius:6px;margin:0 0 12px" />` : ''}
    <p style="margin:0;font-weight:600;color:#141413">${escapeHtml(p.name)}</p>
    ${p.priceLine ? `<p style="margin:4px 0 0;color:#2b2a27">${p.priceLine}</p>` : ''}
  </div>`;
}

/** Gmail/Yahoo one-click unsubscribe (RFC 8058) — required for bulk senders. */
export function unsubscribeHeaders(unsubscribeUrl?: string | null): Record<string, string> | undefined {
  return unsubscribeUrl
    ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;
}

export function formatMoney(amount: number, currency?: string | null): string {
  const code = (currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}
