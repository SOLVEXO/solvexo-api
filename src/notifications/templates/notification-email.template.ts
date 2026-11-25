import { repairMojibake } from '@/common/repair-mojibake.util';
import { emailUiStrings, isRtlLocale } from '../customer-email-locales';

const APP_NAME = process.env.APP_NAME || 'Solvexo';
const BRAND_COLOR = '#d97757';
/** The full Solvexo logo (icon + wordmark, 833×285 PNG) at the top of every platform email. EMAIL_LOGO_URL overrides it. */
export const SOLVEXO_EMAIL_LOGO = 'https://www.solvexo.store/brand/solvexo-logo.png';
function platformLogoUrl(): string | null {
  const v = (process.env.EMAIL_LOGO_URL ?? SOLVEXO_EMAIL_LOGO).trim();
  return /^https:\/\//i.test(v) ? v.replace(/"/g, '%22') : null;
}

/**
 * Modern shared shell for every Notifications-module email — a text wordmark
 * (no external logo asset dependency) in the app's brand color, a rounded
 * card body, and an optional pill CTA button. Kept separate from the older
 * `shell()` helper in subscription-notifications.service.ts /
 * platform-plan-notifications.service.ts, which is out of scope here.
 */
/** How a STORE's customer email is branded. A plain string is just the store name. */
export interface EmailStoreBrand {
  name: string;
  logoUrl?: string | null;
  /** #rrggbb */
  accent?: string | null;
  footerText?: string | null;
  /** Leave out the "you are receiving this because of your order" line (replies to a contact form, newsletters...). */
  hideReceivingNotice?: boolean;
  /** Language of the email ('ur', ...): sets lang/dir, a suitable font stack and the footer wording. */
  locale?: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function notificationEmailShell(
  title: string,
  bodyHtml: string,
  cta?: { label: string; url: string },
  /** A STORE's name: customer-facing mails (shipped, delivered, ...) are branded as the store, not the platform. */
  storeBrand?: string | EmailStoreBrand | null,
  /** Platform mail only: the line under the copyright. Left out = the account-activity line; null = none. */
  platformNote?: string | null,
): string {
  const esc = (s: string) => repairMojibake(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const b: EmailStoreBrand | null = typeof storeBrand === 'string' ? { name: storeBrand } : storeBrand ?? null;
  const brand = b ? esc(b.name) : APP_NAME;
  const accent = b?.accent && HEX.test(b.accent) ? b.accent : BRAND_COLOR;
  const logo = b?.logoUrl && /^https:\/\//i.test(b.logoUrl) ? b.logoUrl.replace(/"/g, '%22') : null;
  // Platform mail carries the real Solvexo logo (width/height set so it never renders huge in clients that ignore CSS).
  const platformLogo = b ? null : platformLogoUrl();
  const wordmarkHtml = logo
    ? `<img src="${logo}" alt="${brand}" style="max-height:56px;max-width:220px;">`
    : platformLogo
      ? `<img src="${platformLogo}" alt="${esc(APP_NAME)}" width="176" height="60" style="display:inline-block;width:176px;height:auto;max-width:176px;border:0;">`
      : `<span>${brand}</span>`;
  const ui = emailUiStrings(b?.locale);
  const rtl = isRtlLocale(b?.locale);
  const lang = esc(String(b?.locale ?? 'en').toLowerCase().split('-')[0] || 'en');
  const footerHtml = b
    ? `${b.footerText ? `<p>${esc(b.footerText)}</p>` : ''}<p>&copy; ${new Date().getFullYear()} ${brand}. ${ui.rightsReserved}</p>
    ${b.hideReceivingNotice ? '' : `<p>${ui.receivingBecause.replace('{brand}', brand)}</p>`}`
    : `<p>&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
    ${platformNote === undefined ? `<p>You're receiving this because of activity on your ${APP_NAME} account. Manage preferences in the app under Notifications.</p>` : platformNote ? `<p>${esc(platformNote)}</p>` : ''}`;
  return `
<!DOCTYPE html>
<html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body {
    font-family: ${rtl ? "'Jameel Noori Nastaleeq', 'Noto Nastaliq Urdu', 'Noto Naskh Arabic', Tahoma, 'Segoe UI', Arial, sans-serif" : "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"};
    line-height: ${rtl ? '2' : '1.6'};
    color: #2b2b2b;
    background: #f5f2ef;
    max-width: 600px;
    margin: 0 auto;
    padding: 24px 16px;
  }
  .wordmark {
    text-align: center;
    padding: 8px 0 24px;
  }
  .wordmark span {
    font-weight: 800;
    font-size: 28px;
    letter-spacing: -0.5px;
    color: ${accent};
  }
  .card {
    background: #ffffff;
    border-radius: 16px;
    padding: 36px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  }
  .card h1 {
    margin: 0 0 16px;
    font-size: 21px;
    color: #1f1f1f;
  }
  .box {
    background: #f8f6f4;
    border-radius: 12px;
    padding: 18px 20px;
    margin: 20px 0;
  }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
  .label { color: #767676; }
  .value { font-weight: 600; color: #222; }
  .amount { font-size: 28px; font-weight: 700; text-align: center; margin: 10px 0; }
  .note, .success, .warning, .danger { border-radius: 12px; padding: 14px 18px; margin: 20px 0; font-size: 14px; }
  .note { background: #f8f6f4; }
  .success { background: #e8f8ee; border-left: 4px solid #22c55e; }
  .warning { background: #fff6dd; border-left: 4px solid #f2b705; }
  .danger { background: #fdecea; border-left: 4px solid #e53935; }
  .code { font-size: 32px; font-weight: 800; letter-spacing: 8px; text-align: center; color: #1f1f1f; background: #f8f6f4; border-radius: 12px; padding: 18px; margin: 20px 0; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; }
  .muted { color: #767676; font-size: 13px; }
  .cta {
    display: inline-block;
    margin: 24px 0 8px;
    padding: 12px 28px;
    background: ${accent};
    color: #ffffff !important;
    text-decoration: none;
    border-radius: 999px;
    font-weight: 600;
    font-size: 14px;
  }
  .footer {
    text-align: center;
    margin-top: 28px;
    color: #9a9a9a;
    font-size: 12px;
  }
</style>
</head>
<body>
  <div class="wordmark">${wordmarkHtml}</div>
  <div class="card">
    <h1>${title}</h1>
    ${bodyHtml}
    ${cta ? `<div style="text-align:center"><a class="cta" href="${cta.url}">${cta.label}</a></div>` : ''}
  </div>
  <div class="footer">
    ${footerHtml}
  </div>
</body>
</html>`;
}

/**
 * A Solvexo-branded platform email (Solvexo talking to its sellers, staff, admins, partners and leads). `bodyHtml` must
 * already be escaped. `note` replaces the footer's "activity on your account" line (null = no line).
 */
export function solvexoEmail(title: string, bodyHtml: string, opts: { cta?: { label: string; url: string }; note?: string | null } = {}): string {
  return notificationEmailShell(escapeEmailText(title), bodyHtml, opts.cta, null, opts.note);
}

/** Escapes text for an email body. */
export function escapeEmailText(s: unknown): string {
  return repairMojibake(String(s ?? '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
