/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { promises as dns } from 'dns';
import { randomBytes } from 'crypto';
import * as tls from 'tls';
import { domainToASCII } from 'url';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { VercelDomainsService } from './vercel-domains.service';

/** The CNAME target every seller's domain points at (see the DNS instructions the seller sees). */
export const CUSTOM_DOMAIN_CNAME_TARGET = 'stores.solvexo.store';
export const PLATFORM_ROOT_DOMAIN = 'solvexo.store';
const MAX_DOMAINS_PER_STORE = 10;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
/** Ownership proof: a TXT record `_solvexo-challenge.<domain>` = `solvexo-verify=<per-claim token>`. DNS pointing at the platform alone
 *  proves nothing (every store's domain points at the same CNAME), so without the token a stranger who claimed a domain first could
 *  get it verified the moment its real owner pointed DNS at us. */
export const TXT_CHALLENGE_PREFIX = '_solvexo-challenge';
/** An UNVERIFIED claim blocks the same domain on other stores for this long; after that a new claim evicts it. */
const UNVERIFIED_CLAIM_HOLD_MS = 60 * 60 * 1000;

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
  /** Secret the seller proves ownership with (TXT record). Absent on domains verified before TXT proof existed (grandfathered). */
  verificationToken?: string;
  /** Set only when the domain was contested (another store's stale claim had to be evicted): then the TXT proof is required in
   *  addition to DNS. A normal, uncontested domain needs just the CNAME/A record — same as Shopify/Vercel. */
  requireTxt?: boolean;
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
    const cleaned = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    // An internationalised domain (Unicode letters) is stored in its ASCII "punycode" form (xn--…): that is what DNS, TLS
    // certificates and Vercel actually use. domainToASCII returns '' for something that is not a valid hostname.
    return /[^\x00-\x7f]/.test(cleaned) ? domainToASCII(cleaned) : cleaned;
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
      // Only shown while the domain still has to be verified.
      txt: e.status !== 'verified' && e.requireTxt && e.verificationToken
        ? { host: `${TXT_CHALLENGE_PREFIX}.${e.domain}`, value: CustomDomainsService.txtValue(e.verificationToken) }
        : null,
    };
  }

  static txtValue(token: string): string { return `solvexo-verify=${token}`; }
  private static newToken(): string { return randomBytes(16).toString('hex'); }

  /** Gives every still-unverified entry its ownership token (also covers entries created before TXT proof existed). */
  private ensureTokens(store: any): boolean {
    let changed = false;
    for (const e of (store.customDomains ?? []) as CustomDomainEntry[]) {
      if (e.status !== 'verified' && e.requireTxt && !e.verificationToken) { e.verificationToken = CustomDomainsService.newToken(); changed = true; }
    }
    return changed;
  }

  /** Does `_solvexo-challenge.<domain>` carry this claim's token? */
  private async checkTxt(domain: string, token: string | undefined): Promise<boolean> {
    if (!token) return false;
    try {
      const records = await dns.resolveTxt(`${TXT_CHALLENGE_PREFIX}.${domain}`);
      const want = CustomDomainsService.txtValue(token);
      return records.some((chunks) => chunks.join('').trim() === want);
    } catch { return false; }
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

  /** The A record a bare (apex) domain should use: configured value, else what the platform target resolves to, else Vercel's
   *  documented anycast IP. Cached for 10 minutes. */
  private aRecordCache: { value: string; at: number } | null = null;
  private async aRecordValue(): Promise<string> {
    const env = process.env.CUSTOM_DOMAIN_A_RECORD?.trim();
    if (env) return env.split(',')[0].trim();
    if (this.aRecordCache && Date.now() - this.aRecordCache.at < 600_000) return this.aRecordCache.value;
    let value = '76.76.21.21';
    try { const ips = await dns.resolve4(CUSTOM_DOMAIN_CNAME_TARGET); if (ips[0]) value = ips[0]; } catch { /* keep the fallback */ }
    this.aRecordCache = { value, at: Date.now() };
    return value;
  }

  private async response(store: any) {
    const primary: string | null = store.primaryDomain ?? null;
    const aRecord = await this.aRecordValue();
    return {
      success: true,
      data: {
        defaultDomain: this.defaultHost(store),
        primaryDomain: primary,
        // What customers are sent to: the primary custom domain when set, else the free address.
        canonicalHost: primary ?? this.defaultHost(store),
        domains: (store.customDomains ?? []).map((d: CustomDomainEntry) => this.pub(d, primary)),
        dns: { cnameTarget: CUSTOM_DOMAIN_CNAME_TARGET, aRecord },
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
    ips.add(await this.aRecordValue()); // exactly the value the seller is shown, so what we display always verifies
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
    const snap = () => JSON.stringify([entry.status, entry.sslStatus, entry.dnsError, entry.verificationToken]);
    const before = snap();
    if (entry.status !== 'verified' && entry.requireTxt && !entry.verificationToken) entry.verificationToken = CustomDomainsService.newToken();
    const dnsRes = await this.checkDns(entry.domain);
    entry.lastCheckedAt = new Date();

    if (!dnsRes.ok) {
      entry.status = 'unverified'; entry.verifiedAt = null; entry.sslStatus = 'none'; entry.dnsError = dnsRes.reason;
      return before !== snap();
    }

    if (entry.status !== 'verified') {
      // Contested domain only: DNS alone proves nothing (it points at the platform for every store) — the TXT record proves THIS claimant controls it.
      if (entry.requireTxt && !(await this.checkTxt(entry.domain, entry.verificationToken))) {
        entry.sslStatus = 'none';
        entry.dnsError = `DNS points to ${CUSTOM_DOMAIN_CNAME_TARGET}, but the ownership TXT record (${TXT_CHALLENGE_PREFIX}.${entry.domain}) was not found yet. Add it as shown below.`;
        return before !== snap();
      }
      entry.status = 'verified'; entry.verifiedAt = new Date();
    }
    entry.dnsError = null;

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
    return before !== snap();
  }

  /** Another store already has this domain? A VERIFIED one keeps it. An unverified claim only holds it for a while (so a stranger
   *  cannot squat a domain forever); a fresh claim after that evicts it — the claimant still has to pass DNS + the TXT proof. */
  /** Returns true when a stale claim was evicted (the domain was contested). */
  private async releaseStaleClaim(storeId: string, domain: string): Promise<boolean> {
    const other: any = await this.stores
      .findOne({ _id: { $ne: storeId }, isDelete: false, $or: [{ 'customDomains.domain': domain }, { customDomain: domain }] })
      .select('customDomains customDomain customDomainStatus')
      .lean();
    if (!other) return false;
    const theirs = (other.customDomains ?? []).find((d: any) => d.domain === domain);
    const verified = theirs ? theirs.status === 'verified' : other.customDomainStatus === 'verified';
    if (verified) throw new BadRequestException('This domain is already connected to another store');
    const addedAt = theirs?.addedAt ? new Date(theirs.addedAt).getTime() : 0;
    if (Date.now() - addedAt < UNVERIFIED_CLAIM_HOLD_MS) {
      throw new BadRequestException('Another store recently started connecting this domain. If you own it, try again in about an hour.');
    }
    await this.stores.updateOne({ _id: other._id }, { $pull: { customDomains: { domain } } });
    if (other.customDomain === domain) await this.stores.updateOne({ _id: other._id }, { $set: { customDomain: null, customDomainStatus: 'unverified' } });
    this.hostCache = null;
    this.logger.warn(`Evicted stale unverified claim on ${domain} from store ${String(other._id)}`);
    return true;
  }

  // ── seller API ──
  async list(sellerId: string, storeId: string) {
    const store = await this.loadOwned(sellerId, storeId);
    if (this.ensureTokens(store)) await this.saveStore(store); // older unverified entries get their TXT token on first view
    return this.response(store);
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
    const contested = await this.releaseStaleClaim(storeId, domain);

    const entry: CustomDomainEntry = {
      domain, status: 'unverified', sslStatus: 'none', addedAt: new Date(), verifiedAt: null, lastCheckedAt: null, dnsError: null,
      ...(contested ? { requireTxt: true, verificationToken: CustomDomainsService.newToken() } : {}),
    };
    store.customDomains = [...(store.customDomains ?? []), entry];
    await this.saveStore(store);
    // The domain is attached to Vercel (HTTPS) only once DNS + the TXT proof pass — see evaluate(); an unproven claim never touches Vercel.

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
    return { ...(await this.response(store)), verified: entry.status === 'verified', reason: entry.dnsError };
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
