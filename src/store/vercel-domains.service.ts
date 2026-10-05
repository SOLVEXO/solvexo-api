/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';

export interface VercelDomainState {
  /** Vercel credentials are configured on this server. */
  configured: boolean;
  /** The domain is attached to our Vercel project. */
  attached: boolean;
  /** Vercel verified ownership of the domain for this project. */
  verified: boolean;
  /** DNS does not (yet) point at Vercel — `null` when unknown. */
  misconfigured: boolean | null;
  error?: string;
}

/**
 * Shopify provisions HTTPS for a connected domain automatically. Our storefront is the `solvexo-web` Vercel project, and
 * Vercel issues + renews the certificate for every domain attached to it — so "TLS automation" = attach / inspect /
 * detach the seller's domain on that project through Vercel's REST API.
 *
 * Needs (set in the API's environment): VERCEL_API_TOKEN, VERCEL_PROJECT_ID, and — only when the project belongs to a
 * team — VERCEL_TEAM_ID. When they are missing every method is a safe no-op that reports `configured: false`, and the
 * rest of the custom-domain feature (DNS checks, primary domain, redirects, CORS) keeps working.
 */
@Injectable()
export class VercelDomainsService {
  private readonly logger = new Logger(VercelDomainsService.name);
  private readonly base = 'https://api.vercel.com';

  private get token() { return process.env.VERCEL_API_TOKEN?.trim(); }
  private get projectId() { return process.env.VERCEL_PROJECT_ID?.trim(); }
  private get teamId() { return process.env.VERCEL_TEAM_ID?.trim(); }

  isConfigured(): boolean { return !!(this.token && this.projectId); }

  private url(path: string): string {
    return `${this.base}${path}${this.teamId ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.teamId)}` : ''}`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(this.url(path), {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  }

  private errorText(json: any, status: number): string {
    return json?.error?.message || `Vercel responded with HTTP ${status}`;
  }

  /** Attach `domain` to the storefront project (idempotent: already attached counts as success). */
  async attach(domain: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) return { ok: true };
    try {
      const { status, json } = await this.call('POST', `/v10/projects/${this.projectId}/domains`, { name: domain });
      if (status >= 200 && status < 300) return { ok: true };
      const code = json?.error?.code;
      if (status === 409 && (code === 'domain_already_in_use' || code === 'domain_already_exists')) {
        // Already attached to THIS project is fine; attached to ANOTHER Vercel project is not.
        const { status: s2, json: j2 } = await this.call('GET', `/v9/projects/${this.projectId}/domains/${encodeURIComponent(domain)}`);
        if (s2 === 200 && j2?.name === domain) return { ok: true };
        return { ok: false, error: 'This domain is already attached to a different Vercel project.' };
      }
      return { ok: false, error: this.errorText(json, status) };
    } catch (err: any) {
      this.logger.warn(`Vercel attach(${domain}) failed: ${err?.message}`);
      return { ok: false, error: 'Could not reach Vercel' };
    }
  }

  /** Ownership/DNS state of `domain` on the project. */
  async inspect(domain: string): Promise<VercelDomainState> {
    if (!this.isConfigured()) return { configured: false, attached: false, verified: false, misconfigured: null };
    try {
      const d = await this.call('GET', `/v9/projects/${this.projectId}/domains/${encodeURIComponent(domain)}`);
      if (d.status === 404) return { configured: true, attached: false, verified: false, misconfigured: null };
      if (d.status !== 200) return { configured: true, attached: false, verified: false, misconfigured: null, error: this.errorText(d.json, d.status) };
      const c = await this.call('GET', `/v6/domains/${encodeURIComponent(domain)}/config`);
      return {
        configured: true,
        attached: true,
        verified: d.json?.verified === true,
        misconfigured: c.status === 200 ? c.json?.misconfigured === true : null,
      };
    } catch (err: any) {
      this.logger.warn(`Vercel inspect(${domain}) failed: ${err?.message}`);
      return { configured: true, attached: false, verified: false, misconfigured: null, error: 'Could not reach Vercel' };
    }
  }

  /** Ask Vercel to re-run its ownership verification for `domain` (no-op when it is already verified). */
  async verify(domain: string): Promise<void> {
    if (!this.isConfigured()) return;
    try { await this.call('POST', `/v9/projects/${this.projectId}/domains/${encodeURIComponent(domain)}/verify`); } catch { /* best effort */ }
  }

  /** Detach `domain` from the project (404 = already gone). */
  async detach(domain: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) return { ok: true };
    try {
      const { status, json } = await this.call('DELETE', `/v9/projects/${this.projectId}/domains/${encodeURIComponent(domain)}`);
      if ((status >= 200 && status < 300) || status === 404) return { ok: true };
      return { ok: false, error: this.errorText(json, status) };
    } catch (err: any) {
      this.logger.warn(`Vercel detach(${domain}) failed: ${err?.message}`);
      return { ok: false, error: 'Could not reach Vercel' };
    }
  }
}
