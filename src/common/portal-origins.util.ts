/** Parses PORTAL_ORIGINS: comma-separated exact origins; wildcards and non-https (except localhost) are dropped. */
export function parsePortalOrigins(raw?: string): string[] {
  return (raw ?? '').split(',').map((o) => o.trim()).filter(Boolean).filter((o) => {
    try {
      const u = new URL(o);
      if (o.includes('*') || u.origin !== o) return false;
      return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
    } catch { return false; }
  });
}
