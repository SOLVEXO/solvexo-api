/* eslint-disable prettier/prettier */
/** One browser Content-Security-Policy violation, reduced to what is useful in a log line (no query strings, no page content). */
export interface CspViolation { directive: string; blocked: string; page: string; disposition: string }

const host = (u: unknown): string => {
  if (typeof u !== 'string' || !u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u.slice(0, 40); // 'inline', 'eval', 'self'…
  try { const p = new URL(u); return p.protocol.startsWith('http') || p.protocol.startsWith('ws') ? p.host : p.protocol.replace(':', ''); } catch { return 'invalid'; }
};
const pagePath = (u: unknown): string => {
  if (typeof u !== 'string') return '';
  try { const p = new URL(u); return `${p.host}${p.pathname}`.slice(0, 120); } catch { return ''; }
};

/** Accepts the legacy `report-uri` shape ({"csp-report":{…}}) and the Reporting API shape ([{type:"csp-violation", body:{…}}]). */
export function parseCspReports(body: unknown): CspViolation[] {
  const items: any[] = Array.isArray(body) ? body.map((r: any) => r?.body).filter(Boolean)
    : body && typeof body === 'object' && (body as any)['csp-report'] ? [(body as any)['csp-report']] : [];
  return items.slice(0, 20).map((r: any) => ({
    directive: String(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '').split(' ')[0].slice(0, 40),
    blocked: host(r['blocked-uri'] ?? r.blockedURL),
    page: pagePath(r['document-uri'] ?? r.documentURL),
    disposition: String(r.disposition ?? 'report').slice(0, 10),
  })).filter((v) => v.directive);
}
