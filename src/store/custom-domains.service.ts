/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { promises as dns } from 'dns';
import * as tls from 'tls';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { VercelDomainsService } from './vercel-domains.service';

/** The CNAME target every seller's domain points at (see the DNS instructions the seller sees). */
export const CUSTOM_DOMAIN_CNAME_TARGET = 'stores.solvexo.store';
export const PLATFORM_ROOT_DOMAIN = 'solvexo.store';
const MAX_DOMAINS_PER_STORE = 10;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export type DomainSsl = 'none' | 'pending' | 'active' | 'failed';
export interface CustomDomainEntry {
  domain: string;
  status: 'unverified' | 'verified';
  sslStatus: DomainSsl;
  addedAt: Date;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  /** Why the last check did not verify (shown to the seller). */
  dnsError: string | null;
}

/**
 * Shopify "Domains": a store can connect several domains, one is the PRIMARY (the address customers are sent to — every
 * other domain, including the free `<slug>.solvexo.store`, redirects to it), DNS is checked automatically, and HTTPS is
 * issued automatically.
 *
 * Source of truth: `Store.customDomains[]` + `Store.primaryDomain`. The older single fields `customDomain` /
 * `customDomainStatus` are kept as a MIRROR of the primary custom domain, because many existing readers (emails, SEO,
 * public resolve…) use them — they always describe the domain the store is served on.
 */
@Injectable()
export class CustomDomainsService implements OnModuleInit {
  private readonly logger = new Logger(CustomDomainsService.name);
  private hostCache: { hosts: Set<string>; at: number } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly entitlements: EntitlementsService,
    private readonly vercel: VercelDomainsService,
  ) {}

  private get stores() { return this.db.repositories.storeModel; }

  // ── one-time, idempotent: legacy single `customDomain` → `customDomains[]` ──
  async onModuleInit() {
    try {
      const legacy: any[] = await this.stores
        .find({ customDomain: { $type: 'string', $ne: '' }, $or: [{ customDomains: { $exists: false } }, { customDomains: { $size: 0 } }] })
        .select('customDomain customDomainStatus')
        .lean();
      for (const s of legacy) {
        const verified = s.customDomainStatus === 'verified';
        const now = new Date();
        await this.stores.updateOne(
          { _id: s._id, customDomains: { $in: [null, []] } },
          {
            $set: {
              customDomains: [{ domain: s.customDomain, status: verified ? 'verified' : 'unverified', sslStatus: verified ? 'pending' : 'none', addedAt: now, verifiedAt: verified ? now : null, lastCheckedAt: null, dnsError: null }],
              primaryDomain: verified ? s.customDomain : null,
              // an unverified legacy domain was never serving the store → it is no longer the mirrored primary
              ...(verified ? {} : { customDomain: null, customDomainStatus: 'unverified' }),
            },
          },
        );
      }
      if (legacy.length) this.logger.log(`Migrated ${legacy.length} legacy custom domain(s) to the multi-domain model`);
    } catch (err: any) {
      this.logger.error(`Custom-domain migration failed: ${err?.message}`);
    }
  }

  // ── helpers ──
  static normalize(raw: string): string {
    return String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  }

  private async loadOwned(sellerId: string, storeId: string) {
    const store: any = await this.stores.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new ForbiddenException('Unauthorized');
    return store;
  }

  private pub(e: CustomDomainEntry, primary: string | null) {
    return {
      domain: e.domain, status: e.status, sslStatus: e.sslStatus, isPrimary: primary === e.domain,
      addedAt: e.addedAt, verifiedAt: e.verifiedAt, lastCheckedAt: e.lastCheckedAt, dnsError: e.dnsError,
    };
  }

  private defaultHost(store: any): string { return `${store.slug}.${PLATFORM_ROOT_DOMAIN}`; }

  /** Keep the legacy single fields describing the PRIMARY domain, and drop the CORS cache. */
  private async saveStore(store: any) {
    const primary = store.primaryDomain && (store.customDomains ?? []).some((d: any) => d.domain === store.primaryDomain && d.status === 'verified') ? store.primaryDomain : null;
    store.primaryDomain = primary;
    store.customDomain = primary;
    store.customDomainStatus = primary ? 'verified' : 'unverified';
    store.markModified('customDomains');
    try {
      await store.save();
    } catch (err: any) {
      if (err?.code === 11000) throw new BadRequestException('This domain is already connected to another store');
      throw err;
    }
    this.hostCache = null;
  }

  private response(store: any) {
    const primary: string | null = store.primaryDomain ?? null;
    return {
      success: true,
      data: {
        defaultDomain: this.defaultHost(store),
        primaryDomain: primary,
        // What customers are sent to: the primary custom domain when set, else the free address.
        canonicalHost: primary ?? this.defaultHost(store),
        domains: (store.customDomains ?? []).map((d: CustomDomainEntry) => this.pub(d, primary)),
        dns: { cnameTarget: CUSTOM_DOMAIN_CNAME_TARGET, aRecord: process.env.CUSTOM_DOMAIN_A_RECORD?.trim() || null },
        httpsAutomation: this.vercel.isConfigured(),
        maxDomains: MAX_DOMAINS_PER_STORE,
      },
    };
  }

  // ── DNS / HTTPS probes ──
  /** Platform IPs a bare (apex) domain may point its A record at. */
  private async platformIps(): Promise<Set<string>> {
    const ips = new Set<string>();
    const env = process.env.CUSTOM_DOMAIN_A_RECORD?.trim();
    if (env) env.split(',').map((s) => s.trim()).filter(Boolean).forEach((i) => ips.add(i));
    try { (await dns.resolve4(CUSTOM_DOMAIN_CNAME_TARGET)).forEach((i) => ips.add(i)); } catch { /* target not resolvable from here */ }
    return ips;
  }

  private async checkDns(domain: string): Promise<{ ok: boolean; reason: string | null }> {
    try {
      const cnames = (await dns.resolveCname(domain)).map((c) => c.toLowerCase().replace(/\.$/, ''));
      if (cnames.some((c) => c === CUSTOM_DOMAIN_CNAME_TARGET || c.endsWith('.vercel-dns.com') || c.endsWith('vercel-dns.com'))) return { ok: true, reason: null };
      return { ok: false, reason: `Found a CNAME (${cnames[0]}), but it doesn't point to ${CUSTOM_DOMAIN_CNAME_TARGET}.` };
    } catch { /* no CNAME — an apex domain uses an A record */ }
    try {
      const mine = await this.platformIps();
      const theirs = await dns.resolve4(domain);
      if (mine.size === 0) return { ok: false, reason: 'No A record target is configured on the platform yet — use a CNAME to ' + CUSTOM_DOMAIN_CNAME_TARGET + ' (for example on www).' };
      if (theirs.some((ip) => mine.has(ip))) return { ok: true, reason: null };
      return { ok: false, reason: `The A record (${theirs.join(', ')}) doesn't point to the platform (${[...mine].join(', ')}).` };
    } catch {
      return { ok: false, reason: `No CNAME or A record found for ${domain} yet — DNS changes can take a few minutes to a few hours to propagate.` };
    }
  }

  /** Real TLS handshake: does the domain already serve a valid certificate for itself? */
  private tlsOk(domain: string): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean) => { if (!done) { done = true; try { socket.destroy(); } catch { /* */ } resolve(v); } };
      const socket = tls.connect({ host: domain, port: 443, servername: domain, timeout: 6000, rejectUnauthorized: true }, () => finish(socket.authorized === true));
      socket.on('error', () => finish(false));
      socket.on('timeout', () => finish(false));
    });
  }

  /** Re-evaluate one entry (DNS → Vercel → HTTPS) and update it in place. Returns true if anything changed. */
  private async evaluate(entry: CustomDomainEntry): Promise<boolean> {
    const before = JSON.stringify([entry.status, entry.sslStatus, entry.dnsError]);
    const dnsRes = await this.checkDns(entry.domain);
    entry.lastCheckedAt = new Date();

    if (!dnsRes.ok) {
      entry.status = 'unverified'; entry.verifiedAt = null; entry.sslStatus = 'none'; entry.dnsError = dnsRes.reason;
      return before !== JSON.stringify([entry.status, entry.sslStatus, entry.dnsError]);
    }

    entry.dnsError = null;
    if (entry.status !== 'verified') { entry.status = 'verified'; entry.verifiedAt = new Date(); }

    // HTTPS: Vercel issues the certificate once the domain is attached and its DNS points at Vercel.
    if (this.vercel.isConfigured()) {
      const att = await this.vercel.attach(entry.domain);
      if (!att.ok) { entry.sslStatus = 'failed'; entry.dnsError = att.error ?? 'Could not attach the domain for HTTPS'; }
      else {
        let st = await this.vercel.inspect(entry.domain);
        if (st.attached && !st.verified) { await this.vercel.verify(entry.domain); st = await this.vercel.inspect(entry.domain); }
        entry.sslStatus = st.attached && st.verified && st.misconfigured === false ? ((await this.tlsOk(entry.domain)) ? 'active' : 'pending') : 'pending';
      }
    } else {
      entry.sslStatus = (await this.tlsOk(entry.domain)) ? 'active' : 'pending';
    }
    return before !== JSON.stringify([entry.status, entry.sslStatus, entry.dnsError]);
  }

  // ── seller API ──
  async list(sellerId: string, storeId: string) {
    return this.response(await this.loadOwned(sellerId, storeId));
  }

  async add(sellerId: string, storeId: string, raw: string, actor: { actorId: string; actorRole: 'seller' | 'staff' }) {
    const store = await this.loadOwned(sellerId, storeId);
    const domain = CustomDomainsService.normalize(raw);
    if (!domain) throw new BadRequestException('Enter a domain, e.g. shop.yourbrand.com');
    await this.entitlements.assertFeatureAllowed(storeId, 'customDomainAllowed', 'Custom domain');
    if (domain.length > 253 || !DOMAIN_RE.test(domain)) throw new BadRequestException('Enter a valid domain, e.g. shop.yourbrand.com');
    if (domain === PLATFORM_ROOT_DOMAIN || domain.endsWith(`.${PLATFORM_ROOT_DOMAIN}`)) {
      throw new BadRequestException('This domain belongs to the platform and cannot be used as a custom domain');
    }
    if ((store.customDomains ?? []).some((d: any) => d.domain === domain)) throw new BadRequestException('This domain is already connected to your store');
    if ((store.customDomains ?? []).length >= MAX_DOMAINS_PER_STORE) throw new BadRequestException(`You can connect up to ${MAX_DOMAINS_PER_STORE} domains`);
    const clash = await this.stores.findOne({ _id: { $ne: storeId }, isDelete: false, $or: [{ 'customDomains.domain': domain }, { customDomain: domain }] }).select('_id').lean();
    if (clash) throw new BadRequestException('This domain is already connected to another store');

    const entry: CustomDomainEntry = { domain, status: 'unverified', sslStatus: 'none', addedAt: new Date(), verifiedAt: null, lastCheckedAt: null, dnsError: null };
    store.customDomains = [...(store.customDomains ?? []), entry];
    await this.saveStore(store);

    // Attach early (Vercel needs it before it can verify/issue HTTPS); the DNS check runs on "Verify" and on a schedule.
    const att = await this.vercel.attach(domain);
    if (!att.ok) {
      store.customDomains = store.customDomains.filter((d: any) => d.domain !== domain);
      await this.saveStore(store);
      throw new BadRequestException(att.error ?? 'Could not connect this domain for HTTPS');
    }

    this.activityLog.log({ storeId, category: 'settings', action: 'domain_added', description: `Domain ${domain} added`, actorId: actor.actorId, actorRole: actor.actorRole });
    return this.response(store);
  }

  async verify(sellerId: string, storeId: string, rawDomain: string, actor: { actorId: string; actorRole: 'seller' | 'staff' }) {
    const store = await this.loadOwned(sellerId, storeId);
    const domain = CustomDomainsService.normalize(rawDomain);
    const entry: CustomDomainEntry | undefined = (store.customDomains ?? []).find((d: any) => d.domain === domain);
    if (!entry) throw new NotFoundException('Domain not found on this store');
    await this.evaluate(entry);
    await this.saveStore(store);
    this.activityLog.log({
      storeId, category: 'settings', action: 'domain_verify_attempted',
      description: entry.status === 'verified' ? `Domain ${domain} verified` : `Domain ${domain} not verified: ${entry.dnsError}`,
      actorId: actor.actorId, actorRole: actor.actorRole,
    });
    return { ...this.response(store), verified: entry.status === 'verified', reason: entry.dnsError };
  }

  /** `domain === null` makes the free `<slug>.solvexo.store` address the primary. */
  async setPrimary(sellerId: string, storeId: string, rawDomain: string | null, actor: { actorId: string; actorRole: 'seller' | 'staff' }) {
    const store = await this.loadOwned(sellerId, storeId);
    if (rawDomain == null || rawDomain === '') {
      store.primaryDomain = null;
    } else {
      const domain = CustomDomainsService.normalize(rawDomain);
      const entry = (store.customDomains ?? []).find((d: any) => d.domain === domain);
      if (!entry) throw new NotFoundException('Domain not found on this store');
      if (entry.status !== 'verified') throw new BadRequestException('Verify the domain before making it primary');
      store.primaryDomain = domain;
    }
    await this.saveStore(store);
    this.activityLog.log({ storeId, category: 'settings', action: 'domain_primary_changed', description: `Primary domain set to ${store.primaryDomain ?? this.defaultHost(store)}`, actorId: actor.actorId, actorRole: actor.actorRole });
    return this.response(store);
  }

  async remove(sellerId: string, storeId: string, rawDomain: string, actor: { actorId: string; actorRole: 'seller' | 'staff' }) {
    const store = await this.loadOwned(sellerId, storeId);
    const domain = CustomDomainsService.normalize(rawDomain);
    if (!(store.customDomains ?? []).some((d: any) => d.domain === domain)) throw new NotFoundException('Domain not found on this store');
    store.customDomains = store.customDomains.filter((d: any) => d.domain !== domain);
    if (store.primaryDomain === domain) store.primaryDomain = null; // customers fall back to the free address
    await this.saveStore(store);
    await this.vercel.detach(domain);
    this.activityLog.log({ storeId, category: 'settings', action: 'domain_removed', description: `Domain ${domain} removed`, actorId: actor.actorId, actorRole: actor.actorRole });
    return this.response(store);
  }

  // ── background re-check (Shopify detects DNS changes by itself) ──
  async recheckPending(): Promise<number> {
    const rows: any[] = await this.stores
      .find({ isDelete: false, customDomains: { $elemMatch: { $or: [{ status: 'unverified' }, { sslStatus: { $in: ['pending', 'failed'] } }] } } })
      .limit(200);
    let changed = 0;
    for (const store of rows) {
      let dirty = false;
      for (const entry of store.customDomains as CustomDomainEntry[]) {
        // an unverified domain nobody fixed for 14 days is only re-checked once a day instead of every run
        if (entry.status === 'unverified' && entry.lastCheckedAt && Date.now() - new Date(entry.addedAt).getTime() > 14 * 86_400_000
          && Date.now() - new Date(entry.lastCheckedAt).getTime() < 86_400_000) continue;
        if (entry.status === 'verified' && entry.sslStatus === 'active') continue;
        try { if (await this.evaluate(entry)) dirty = true; } catch (err: any) { this.logger.warn(`recheck ${entry.domain}: ${err?.message}`); }
      }
      if (dirty) { await this.saveStore(store); changed++; }
    }
    return changed;
  }

  // ── public lookups ──
  /** Hostnames of every VERIFIED custom domain — used to let those storefronts call the API (CORS). Cached 60 s. */
  async verifiedHostnames(): Promise<Set<string>> {
    if (this.hostCache && Date.now() - this.hostCache.at < 60_000) return this.hostCache.hosts;
    const rows: any[] = await this.stores
      .find({ isDelete: false, $or: [{ 'customDomains.status': 'verified' }, { customDomainStatus: 'verified' }] })
      .select('customDomains customDomain customDomainStatus')
      .lean();
    const hosts = new Set<string>();
    for (const s of rows) {
      for (const d of s.customDomains ?? []) if (d.status === 'verified') hosts.add(String(d.domain).toLowerCase());
      if (s.customDomain && s.customDomainStatus === 'verified') hosts.add(String(s.customDomain).toLowerCase());
    }
    this.hostCache = { hosts, at: Date.now() };
    return hosts;
  }

  async isVerifiedOrigin(origin: string): Promise<boolean> {
    try {
      const host = new URL(origin).hostname.toLowerCase();
      return (await this.verifiedHostnames()).has(host);
    } catch { return false; }
  }
}
