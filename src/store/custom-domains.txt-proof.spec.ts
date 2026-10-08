/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

jest.mock('dns', () => ({
  promises: {
    resolveCname: jest.fn(),
    resolve4: jest.fn(),
    resolveTxt: jest.fn(),
  },
}));
jest.mock('tls', () => ({ connect: jest.fn() }));

import { promises as dns } from 'dns';
import { CustomDomainsService, TXT_CHALLENGE_PREFIX } from './custom-domains.service';
import { assertSafeSeoDestination } from '../seo/services/seo-url-safety.util';

const cname = dns.resolveCname as unknown as jest.Mock;
const resolve4 = dns.resolve4 as unknown as jest.Mock;
const txt = dns.resolveTxt as unknown as jest.Mock;

function makeService(stores: any) {
  const vercel: any = { isConfigured: () => false, attach: jest.fn(), inspect: jest.fn(), verify: jest.fn(), detach: jest.fn() };
  const db: any = { repositories: { storeModel: stores } };
  const svc = new CustomDomainsService(db, { log: jest.fn() } as any, { assertFeatureAllowed: jest.fn() } as any, vercel);
  return { svc, vercel };
}

const entry = (over: any = {}) => ({
  domain: 'shop.ali.com', status: 'unverified', sslStatus: 'none', addedAt: new Date(), verifiedAt: null, lastCheckedAt: null, dnsError: null,
  verificationToken: 'tok123', requireTxt: true, ...over,
});

describe('custom domain TXT ownership proof', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    cname.mockResolvedValue(['stores.solvexo.store']);
    resolve4.mockRejectedValue(new Error('none'));
  });

  it('does NOT verify when DNS is right but the TXT record is missing', async () => {
    txt.mockRejectedValue(new Error('ENODATA'));
    const { svc } = makeService({});
    const e: any = entry();
    await (svc as any).evaluate(e);
    expect(e.status).toBe('unverified');
    expect(e.dnsError).toContain(TXT_CHALLENGE_PREFIX);
  });

  it('does NOT verify when the TXT token belongs to someone else', async () => {
    txt.mockResolvedValue([['solvexo-verify=other-store-token']]);
    const { svc } = makeService({});
    const e: any = entry();
    await (svc as any).evaluate(e);
    expect(e.status).toBe('unverified');
  });

  it('verifies when CNAME and the TXT token both match (split TXT chunks are joined)', async () => {
    txt.mockResolvedValue([['solvexo-verify=', 'tok123']]);
    const { svc } = makeService({});
    const e: any = entry();
    await (svc as any).evaluate(e);
    expect(e.status).toBe('verified');
    expect(e.dnsError).toBeNull();
    expect(e.verifiedAt).toBeInstanceOf(Date);
  });

  it('does not check TXT for a legacy verified domain without a token (grandfathered)', async () => {
    txt.mockRejectedValue(new Error('ENODATA'));
    const { svc } = makeService({});
    const e: any = entry({ status: 'verified', verificationToken: undefined, verifiedAt: new Date() });
    await (svc as any).evaluate(e);
    expect(e.status).toBe('verified');
    expect(txt).not.toHaveBeenCalled();
  });

  it('gives an unverified entry without a token a fresh one', async () => {
    txt.mockRejectedValue(new Error('ENODATA'));
    const { svc } = makeService({});
    const e: any = entry({ verificationToken: undefined });
    const changed = await (svc as any).evaluate(e);
    expect(e.verificationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(changed).toBe(true);
  });

  it('never exposes the TXT record once a domain is verified', () => {
    const { svc } = makeService({});
    expect((svc as any).pub(entry({ status: 'verified' }), null).txt).toBeNull();
    expect((svc as any).pub(entry(), null).txt).toEqual({ host: '_solvexo-challenge.shop.ali.com', value: 'solvexo-verify=tok123' });
  });

  describe('claims on a domain another store holds', () => {
    const stores = (other: any) => ({ findOne: () => ({ select: () => ({ lean: async () => other }) }), updateOne: jest.fn() });

    it('refuses when the other store has it VERIFIED', async () => {
      const { svc } = makeService(stores({ _id: 'b', customDomains: [entry({ status: 'verified', addedAt: new Date(0) })] }));
      await expect((svc as any).releaseStaleClaim('a', 'shop.ali.com')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a fresh unverified claim (held for an hour)', async () => {
      const { svc } = makeService(stores({ _id: 'b', customDomains: [entry({ addedAt: new Date() })] }));
      await expect((svc as any).releaseStaleClaim('a', 'shop.ali.com')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('evicts a stale unverified claim', async () => {
      const m: any = stores({ _id: 'b', customDomains: [entry({ addedAt: new Date(Date.now() - 2 * 3600_000) })] });
      const { svc } = makeService(m);
      await expect((svc as any).releaseStaleClaim('a', 'shop.ali.com')).resolves.toBe(true);
      expect(m.updateOne).toHaveBeenCalledWith({ _id: 'b' }, { $pull: { customDomains: { domain: 'shop.ali.com' } } });
    });
  });
});

describe('SEO destination allow-list', () => {
  it('allows a store subdomain and the store\'s own verified domain, still rejects strangers', () => {
    expect(() => assertSafeSeoDestination('https://hello.solvexo.store/a')).not.toThrow();
    expect(() => assertSafeSeoDestination('https://shop.ali.com/a', ['shop.ali.com'])).not.toThrow();
    expect(() => assertSafeSeoDestination('https://shop.ali.com/a')).toThrow(BadRequestException);
    expect(() => assertSafeSeoDestination('https://evilsolvexo.store/a')).toThrow(BadRequestException);
    expect(() => assertSafeSeoDestination('//evil.com')).toThrow(BadRequestException);
  });
});
