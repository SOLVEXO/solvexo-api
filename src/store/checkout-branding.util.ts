/* eslint-disable prettier/prettier */
/**
 * Checkout branding (Shopify "checkout branding"): logo, accent colour and footer links shown on the checkout pages of EVERY theme.
 * Plain data only: https images, #rrggbb colours, https or site-relative links. Anything else is refused.
 */
export interface CheckoutBranding { logoUrl: string | null; accentColor: string | null; footerLinks: { label: string; url: string }[] }

const MAX_LINKS = 5;
const isHttps = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password; } catch { return false; } };

/** Validates the seller's input. `null`/`{}` clears the branding. Throws an Error with a seller-facing message. */
export function cleanCheckoutBranding(input: unknown): CheckoutBranding | null {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid checkout branding');
  const i = input as Record<string, unknown>;
  let logoUrl: string | null = null;
  if (typeof i.logoUrl === 'string' && i.logoUrl.trim()) { const u = i.logoUrl.trim(); if (u.length > 500 || !isHttps(u)) throw new Error('The logo must be an https image address'); logoUrl = u; }
  let accentColor: string | null = null;
  if (typeof i.accentColor === 'string' && i.accentColor.trim()) { const c = i.accentColor.trim(); if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error('The accent colour must look like #1a2b3c'); accentColor = c.toLowerCase(); }
  const links: { label: string; url: string }[] = [];
  if (i.footerLinks !== undefined && i.footerLinks !== null) {
    if (!Array.isArray(i.footerLinks) || i.footerLinks.length > MAX_LINKS) throw new Error(`At most ${MAX_LINKS} footer links`);
    for (const l of i.footerLinks as any[]) {
      const label = typeof l?.label === 'string' ? l.label.trim().slice(0, 40) : ''; const url = typeof l?.url === 'string' ? l.url.trim() : '';
      if (!label || !url || url.length > 300) throw new Error('Each footer link needs a label and an address');
      if (!(isHttps(url) || /^\/(?!\/)[A-Za-z0-9\-._~/%?=&#]*$/.test(url))) throw new Error('Footer links must be https addresses or pages of your store (like /policies/refund)');
      links.push({ label, url });
    }
  }
  if (!logoUrl && !accentColor && links.length === 0) return null;
  return { logoUrl, accentColor, footerLinks: links };
}
