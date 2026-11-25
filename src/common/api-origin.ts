/* eslint-disable prettier/prettier */

/**
 * Public origin of THIS API, for links in emails that must hit an `/api/*`
 * route (unsubscribe, click/open tracking, abandoned-cart recovery).
 *
 * Not `https://solvexo.store` — that host is the Vercel-hosted web app, whose
 * catch-all rewrite serves index.html for every path, so `/api/*` links on it
 * open the SPA instead of reaching the backend. API_PUBLIC_URL overrides it
 * for staging/local.
 */
export const API_PUBLIC_ORIGIN = (process.env.API_PUBLIC_URL || 'https://api.solvexo.store').replace(/\/+$/, '');

/**
 * G5.2.0b — the CUSTOMER-FACING origin of receipt links (every receipt QR and share link: `/r/s/<store>/<key>`, `/r/<token>`). The page itself is still
 * served by this API; the web app at RECEIPT_PUBLIC_URL proxies `/r/*` to API_PUBLIC_URL (hand-off note in the admin API doc). Optional: unset → the
 * API origin, so nothing changes until the web team's rewrite is live. Checked at boot with the same rules as API_PUBLIC_URL when set.
 */
export const RECEIPT_PUBLIC_ORIGIN = (process.env.RECEIPT_PUBLIC_URL || '').trim().replace(/\/+$/, '') || API_PUBLIC_ORIGIN;
