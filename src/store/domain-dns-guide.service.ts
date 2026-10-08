/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/** `shop.ali.co.uk` → { registrable: 'ali.co.uk', sub: 'shop' }; `ali.com` → { registrable: 'ali.com', sub: null }. */
export function splitDomain(domain: string): { registrable: string; sub: string | null } {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  const regLen = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  const registrable = labels.slice(-regLen).join('.');
  const sub = labels.slice(0, Math.max(0, labels.length - regLen)).join('.');
  return { registrable, sub: sub || null };
}

/** Where a domain's DNS is managed, judged from its nameservers (records must be edited THERE, not necessarily at the registrar). */
const DNS_PROVIDERS: Array<{ match: RegExp; name: string; url: string }> = [
  { match: /cloudflare\.com$/, name: 'Cloudflare', url: 'https://dash.cloudflare.com' },
  { match: /domaincontrol\.com$/, name: 'GoDaddy', url: 'https://dcc.godaddy.com/control/portfolio' },
  { match: /registrar-servers\.com$/, name: 'Namecheap', url: 'https://ap.www.namecheap.com/domains/list/' },
  { match: /(googledomains\.com|squarespacedns\.com)$/, name: 'Squarespace Domains', url: 'https://account.squarespace.com/domains' },
  { match: /awsdns-[\w.-]*\.(com|net|org|co\.uk)$/, name: 'AWS Route 53', url: 'https://console.aws.amazon.com/route53/' },
  { match: /dns-parking\.com$/, name: 'Hostinger', url: 'https://hpanel.hostinger.com/domains' },
  { match: /(bluehost\.com|hostmonster\.com)$/, name: 'Bluehost', url: 'https://my.bluehost.com' },
  { match: /hostgator\.com$/, name: 'HostGator', url: 'https://portal.hostgator.com' },
  { match: /(ui-dns\.(com|de|org|biz)|ionos\.com)$/, name: 'IONOS', url: 'https://my.ionos.com/domains' },
  { match: /(spaceship\.net|launch\d*\.spaceship\.net)$/, name: 'Spaceship', url: 'https://www.spaceship.com/application/domain-list-application/' },
  { match: /digitalocean\.com$/, name: 'DigitalOcean', url: 'https://cloud.digitalocean.com/networking/domains' },
  { match: /vercel-dns\.com$/, name: 'Vercel', url: 'https://vercel.com/dashboard/domains' },
  { match: /(wixdns\.net)$/, name: 'Wix', url: 'https://manage.wix.com/account/domains' },
  { match: /(netlify\.com|nsone\.net)$/, name: 'Netlify', url: 'https://app.netlify.com/teams' },
  { match: /(name-services\.com|enom\.com)$/, name: 'Name.com / eNom', url: 'https://www.name.com/account/domain' },
  { match: /(hover\.com)$/, name: 'Hover', url: 'https://www.hover.com/domains' },
  { match: /(dynadot\.com)$/, name: 'Dynadot', url: 'https://www.dynadot.com/account/domain/name/list.html' },
];

export interface GuideRecord {
  type: 'A' | 'CNAME';
  /** The "Name/Host" value for the registrar form: `@`, `www`, `shop`… */
  name: string;
  fqdn: string;
  expected: string;
  current: string[];
  /** ok = already correct · add = nothing there yet · update = something else is there and must change. */
  action: 'ok' | 'add' | 'update';
}
export interface GuideRemove { type: 'A' | 'AAAA' | 'CNAME'; name: string; fqdn: string; value: string }
export interface DomainDnsGuide {
  domain: string;
  registrable: string;
  records: GuideRecord[];
  remove: GuideRemove[];
  provider: { name: string; url: string | null } | null;
  nameservers: string[];
  allSet: boolean;
}
export interface GuideTargets { cnameTarget: string; aRecord: string; platformIps: string[] }

const norm = (v: string) => v.toLowerCase().replace(/\.$/, '');

/**
 * Shopify's "Configure DNS records" box: it reads the domain's CURRENT DNS and tells the owner exactly what to add, what to
 * change ("current → update to") and what to delete (an old A/AAAA record on the same name blocks a CNAME). For a bare or
 * `www` domain it always shows BOTH the apex A record and the `www` CNAME, because customers type either.
 */
@Injectable()
export class DomainDnsGuideService {
  private readonly logger = new Logger(DomainDnsGuideService.name);

  private async safe<T>(p: Promise<T>, fallback: T): Promise<T> { try { return await p; } catch { return fallback; } }

  private isOurCname(value: string, t: GuideTargets) {
    const v = norm(value);
    return v === norm(t.cnameTarget) || v.endsWith('vercel-dns.com');
  }

  async build(domain: string, t: GuideTargets): Promise<DomainDnsGuide> {
    const { registrable, sub } = splitDomain(domain);
    const ips = new Set(t.platformIps);
    const wanted: Array<{ type: 'A' | 'CNAME'; name: string; fqdn: string; expected: string }> =
      sub === null || sub === 'www'
        ? [
            { type: 'A', name: '@', fqdn: registrable, expected: t.aRecord },
            { type: 'CNAME', name: 'www', fqdn: `www.${registrable}`, expected: t.cnameTarget },
          ]
        : [{ type: 'CNAME', name: sub, fqdn: domain, expected: t.cnameTarget }];

    const records: GuideRecord[] = [];
    const remove: GuideRemove[] = [];
    for (const w of wanted) {
      const [cnames, a, aaaa] = await Promise.all([
        this.safe(dns.resolveCname(w.fqdn), [] as string[]),
        this.safe(dns.resolve4(w.fqdn), [] as string[]),
        this.safe(dns.resolve6(w.fqdn), [] as string[]),
      ]);
      if (w.type === 'CNAME') {
        if (cnames.length) {
          const ok = cnames.some((c) => this.isOurCname(c, t));
          records.push({ ...w, current: cnames.map(norm), action: ok ? 'ok' : 'update' });
        } else {
          // resolve4 returned real A records on this very name (there is no CNAME to follow) → they block the CNAME.
          records.push({ ...w, current: [], action: 'add' });
          for (const ip of a) remove.push({ type: 'A', name: w.name, fqdn: w.fqdn, value: ip });
          for (const ip of aaaa) remove.push({ type: 'AAAA', name: w.name, fqdn: w.fqdn, value: ip });
        }
      } else {
        const own = cnames.length > 0; // a CNAME on the apex name would hide the A record
        const foreign = a.filter((ip) => !ips.has(ip));
        const hasOurs = a.some((ip) => ips.has(ip));
        let action: GuideRecord['action'];
        if (own) action = 'update';
        else if (!a.length) action = 'add';
        else if (!hasOurs) action = 'update'; // the owner edits the existing record to our IP
        else action = foreign.length ? 'update' : 'ok';
        records.push({ ...w, current: own ? cnames.map(norm) : a, action });
        if (own) cnames.forEach((c) => remove.push({ type: 'CNAME', name: w.name, fqdn: w.fqdn, value: norm(c) }));
        // ours is already there, any OTHER A record on the name must go (visitors would be split between hosts)
        if (hasOurs) foreign.forEach((ip) => remove.push({ type: 'A', name: w.name, fqdn: w.fqdn, value: ip }));
        // an IPv6 record on the apex sends IPv6 visitors to the old host
        aaaa.forEach((ip) => remove.push({ type: 'AAAA', name: w.name, fqdn: w.fqdn, value: ip }));
      }
    }

    const nameservers = (await this.safe(dns.resolveNs(registrable), [] as string[])).map(norm);
    return {
      domain, registrable, records, remove,
      provider: await this.detectProvider(registrable, nameservers),
      nameservers,
      allSet: records.every((r) => r.action === 'ok') && remove.length === 0,
    };
  }

  private async detectProvider(registrable: string, nameservers: string[]): Promise<DomainDnsGuide['provider']> {
    for (const ns of nameservers) {
      const hit = DNS_PROVIDERS.find((p) => p.match.test(ns));
      if (hit) return { name: hit.name, url: hit.url };
    }
    // Unknown DNS host: at least name the registrar (RDAP is the public, key-less successor of WHOIS).
    try {
      const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(registrable)}`, { signal: AbortSignal.timeout(4000), redirect: 'follow', headers: { accept: 'application/rdap+json' } });
      if (!res.ok) return null;
      const json: any = await res.json();
      const reg = (json?.entities ?? []).find((e: any) => (e.roles ?? []).includes('registrar'));
      const fn = reg?.vcardArray?.[1]?.find((v: any[]) => v[0] === 'fn')?.[3];
      return fn ? { name: String(fn), url: null } : null;
    } catch (err: any) {
      this.logger.debug(`RDAP lookup for ${registrable} failed: ${err?.message}`);
      return null;
    }
  }
}
