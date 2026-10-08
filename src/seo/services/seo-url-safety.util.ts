/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

// Same production hosts CORS already trusts in main.ts — reused here as the
// allow-list for absolute redirect/canonical destinations so this doesn't
// become a second, drifting source of truth for "which hosts are ours."
const ALLOWED_ABSOLUTE_HOSTS = ['solvexo.store', 'staging.solvexo.store', 'api.edudeen.com'];

/**
 * Guards against open-redirect abuse in SeoRedirect/SeoCanonicalRule: a
 * destination/canonical URL must be either a same-origin-relative path
 * (starts with a single `/`, not `//` which browsers treat as protocol-
 * relative to an arbitrary host) or an absolute `https://` URL on one of our
 * own domains. Anything else is rejected outright — there is no legitimate
 * reason for this platform to redirect or canonicalize to a third-party host.
 */
export function assertSafeSeoDestination(value: string, ownHosts: string[] = []): void {
  if (value.startsWith('/') && !value.startsWith('//')) return;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Destination must be a relative path (starting with "/") or a valid absolute URL.');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException('Absolute destination URLs must use https.');
  }
  const host = url.hostname.toLowerCase();
  // `<slug>.solvexo.store` storefronts and the store's own connected domains are ours too.
  if (!ALLOWED_ABSOLUTE_HOSTS.includes(host) && !host.endsWith('.solvexo.store') && !ownHosts.includes(host)) {
    throw new BadRequestException(`Absolute destination URLs must point to a Solvexo domain or one of your connected domains (got "${url.hostname}").`);
  }
}

/** The store's own VERIFIED connected domains — absolute canonical/redirect targets may point at them. */
export async function storeSeoHosts(db: { repositories: { storeModel: any } }, storeId: string | null): Promise<string[]> {
  if (!storeId) return [];
  const store: any = await db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('customDomains customDomain customDomainStatus').lean();
  if (!store) return [];
  const hosts = new Set<string>();
  for (const d of store.customDomains ?? []) if (d?.status === 'verified' && d.domain) hosts.add(String(d.domain).toLowerCase());
  if (store.customDomain && store.customDomainStatus === 'verified') hosts.add(String(store.customDomain).toLowerCase());
  return [...hosts];
}
