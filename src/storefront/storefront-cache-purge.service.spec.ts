import { StorefrontCachePurgeService } from './storefront-cache-purge.service';

const ID = 'a1b2c3d4e5f60718293a4b5c';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('StorefrontCachePurgeService', () => {
  const env = { ...process.env };
  let calls: Array<{ url: string; init: any }>;

  const make = () => {
    const svc = new StorefrontCachePurgeService();
    (svc as any).delayMs = 15;
    return svc;
  };

  beforeEach(() => {
    process.env = { ...env };
    calls = [];
    (global as any).fetch = async (url: any, init: any) => { calls.push({ url: String(url), init }); return { ok: true, status: 200 }; };
    process.env.VERCEL_API_TOKEN = 'tok';
    process.env.VERCEL_PROJECT_ID = 'prj_1';
    delete process.env.VERCEL_TEAM_ID;
  });

  it('asks Vercel to invalidate the store tag, with the documented endpoint, query and body', async () => {
    make().purgeStore(ID);
    await wait(60);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.vercel.com/v1/edge-cache/invalidate-by-tags');
    expect(u.searchParams.get('projectIdOrName')).toBe('prj_1');
    expect(u.searchParams.get('teamId')).toBeNull();
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ tags: [`store-${ID}`], target: 'production' });
  });

  it('adds the team when one is configured', async () => {
    process.env.VERCEL_TEAM_ID = 'team_9';
    make().purgeStore(ID);
    await wait(60);
    expect(new URL(calls[0].url).searchParams.get('teamId')).toBe('team_9');
  });

  it('turns a burst of saves into ONE purge', async () => {
    const svc = make();
    svc.purgeStore(ID); svc.purgeStore(ID); svc.purgeStore(ID);
    await wait(80);
    expect(calls).toHaveLength(1);
  });

  it('does nothing without Vercel credentials, and ignores anything that is not a store id', async () => {
    delete process.env.VERCEL_API_TOKEN;
    make().purgeStore(ID);
    process.env.VERCEL_API_TOKEN = 'tok';
    const svc = make();
    svc.purgeStore('not-an-id'); svc.purgeStore(undefined); svc.purgeStore({ $ne: null }); svc.purgeStore('store-' + ID);
    await wait(60);
    expect(calls).toHaveLength(0);
  });

  it('never throws when Vercel refuses or the network fails', async () => {
    (global as any).fetch = async () => { throw new Error('offline'); };
    make().purgeStore(ID);
    await wait(60);
    (global as any).fetch = async () => ({ ok: false, status: 403 });
    make().purgeStore(ID);
    await wait(60);
  });

  it('the static helper reaches the running instance and is a no-op before one exists', async () => {
    StorefrontCachePurgeService.purge(ID); // whichever instance exists must not throw
    make();
    StorefrontCachePurgeService.purge(ID);
    await wait(60);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
