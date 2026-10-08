/* eslint-disable prettier/prettier */
jest.mock('dns', () => ({
  promises: { resolveCname: jest.fn(), resolve4: jest.fn(), resolve6: jest.fn(), resolveNs: jest.fn(), resolveTxt: jest.fn() },
}));

import { promises as dns } from 'dns';
import { DomainDnsGuideService, splitDomain } from './domain-dns-guide.service';

const d = dns as unknown as Record<string, jest.Mock>;
type Zone = { cname?: Record<string, string[]>; a?: Record<string, string[]>; aaaa?: Record<string, string[]>; ns?: string[] };
function setZone(z: Zone) {
  const miss = () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  d.resolveCname.mockImplementation((n: string) => (z.cname?.[n] ? Promise.resolve(z.cname[n]) : miss()));
  d.resolve4.mockImplementation((n: string) => (z.a?.[n] ? Promise.resolve(z.a[n]) : miss()));
  d.resolve6.mockImplementation((n: string) => (z.aaaa?.[n] ? Promise.resolve(z.aaaa[n]) : miss()));
  d.resolveNs.mockImplementation(() => (z.ns ? Promise.resolve(z.ns) : miss()));
}
const T = { cnameTarget: 'stores.solvexo.store', aRecord: '76.76.21.21', platformIps: ['76.76.21.21'] };

describe('DomainDnsGuideService', () => {
  const g = new DomainDnsGuideService();
  beforeEach(() => { jest.resetAllMocks(); (global as any).fetch = jest.fn().mockRejectedValue(new Error('offline')); });

  it('splits registrable domain and subdomain (incl. second-level TLDs)', () => {
    expect(splitDomain('ali.com')).toEqual({ registrable: 'ali.com', sub: null });
    expect(splitDomain('shop.ali.co.uk')).toEqual({ registrable: 'ali.co.uk', sub: 'shop' });
    expect(splitDomain('www.ali.com')).toEqual({ registrable: 'ali.com', sub: 'www' });
  });

  it('bare and www domains always get BOTH the apex A record and the www CNAME', async () => {
    setZone({});
    for (const dom of ['ali.com', 'www.ali.com']) {
      const r = await g.build(dom, T);
      expect(r.records.map((x) => [x.type, x.name, x.action])).toEqual([['A', '@', 'add'], ['CNAME', 'www', 'add']]);
    }
  });

  it('a subdomain only needs its own CNAME, and a wrong target is an update', async () => {
    setZone({ cname: { 'shop.ali.com': ['other.example.net'] } });
    const r = await g.build('shop.ali.com', T);
    expect(r.records).toHaveLength(1);
    expect([r.records[0].name, r.records[0].action]).toEqual(['shop', 'update']);
  });

  it('an old A/AAAA record on the www name blocks the CNAME and is listed for removal', async () => {
    setZone({ a: { 'www.ali.com': ['1.2.3.4'] }, aaaa: { 'www.ali.com': ['::1'] } });
    const r = await g.build('www.ali.com', T);
    expect(r.remove.filter((x) => x.name === 'www').map((x) => [x.type, x.value])).toEqual([['A', '1.2.3.4'], ['AAAA', '::1']]);
  });

  it('apex on an old host is an update; ours plus a stray A means the stray one must go', async () => {
    setZone({ a: { 'ali.com': ['49.212.207.106'] } });
    expect((await g.build('ali.com', T)).records.find((x) => x.type === 'A')!.action).toBe('update');
    setZone({ a: { 'ali.com': ['76.76.21.21', '9.9.9.9'] } });
    expect((await g.build('ali.com', T)).remove.map((x) => x.value)).toEqual(['9.9.9.9']);
  });

  it('is allSet when everything already points at the platform', async () => {
    setZone({ a: { 'ali.com': ['76.76.21.21'] }, cname: { 'www.ali.com': ['stores.solvexo.store.'] } });
    expect((await g.build('ali.com', T)).allSet).toBe(true);
  });

  it('detects the DNS host from the nameservers, and survives an unknown one', async () => {
    setZone({ ns: ['ada.ns.cloudflare.com'] });
    expect((await g.build('ali.com', T)).provider?.name).toBe('Cloudflare');
    setZone({ ns: ['ns1.weird-host.example'] });
    expect((await g.build('ali.com', T)).provider).toBeNull();
  });
});
