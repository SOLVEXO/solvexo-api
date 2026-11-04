/**
 * Where each part of the web app lives. `FRONTEND_URL` is the marketing site (www.solvexo.store); the seller
 * panel is on `seller.<domain>` and the Solvexo owner/admin team on `superadmin.<domain>` (no `/admin` prefix).
 * Override with `SELLER_APP_URL` / `SUPERADMIN_APP_URL`; otherwise they are derived from `FRONTEND_URL`.
 * A bare host such as `localhost` (dev) is returned unchanged so old single-host setups keep working.
 */
function derive(prefix: 'seller' | 'superadmin', envName: string): string {
  const explicit = process.env[envName];
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  try {
    const url = new URL(base);
    if (url.hostname === 'localhost' || /^\d+(\.\d+){3}$/.test(url.hostname)) return base;
    url.hostname = `${prefix}.${url.hostname.replace(/^www\./, '')}`;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return base;
  }
}

export const sellerAppUrl = () => derive('seller', 'SELLER_APP_URL');
export const superadminAppUrl = () => derive('superadmin', 'SUPERADMIN_APP_URL');
