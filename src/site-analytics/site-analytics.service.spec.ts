/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { SiteAnalyticsService } from './site-analytics.service';

function setup(opts: { connected?: boolean } = {}) {
  let doc: any = null;
  const settingsModel: any = {
    findOne: jest.fn(() => ({ lean: async () => doc })),
    updateOne: jest.fn(async (_f: any, u: any) => { doc = { ...(doc ?? {}), ...u.$setOnInsert, ...u.$set }; }),
  };
  const integrations: any = {
    platformGa4Status: jest.fn(async () => ({ connected: opts.connected !== false, status: 'connected', propertyId: 'properties/42', lastError: null })),
    platformGa4Access: jest.fn(async () => (opts.connected === false ? null : { accessToken: 'tok', propertyId: 'properties/42' })),
    markPlatformGa4NeedsReauth: jest.fn(async () => undefined),
  };
  const svc = new SiteAnalyticsService(integrations, settingsModel);
  const calls: { url: string; body: any }[] = [];
  let reply: (url: string, body: any) => { status?: number; json: any } = () => ({ json: {} });
  svc.fetchImpl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const r = reply(String(url), body);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json } as any;
  }) as any;
  return { svc, integrations, settingsModel, calls, setReply: (f: typeof reply) => { reply = f; } };
}

const totalsReport = (metrics: string[], values: number[]) => ({ metricHeaders: metrics.map((name) => ({ name })), rows: [{ metricValues: values.map((v) => ({ value: String(v) })) }] });

describe('SiteAnalyticsService', () => {
  it('saves a valid measurement id, refuses a bad one, and only gives the public site an id when tracking is on', async () => {
    const { svc } = setup();
    expect((await svc.getPublicConfig('PK')).data).toEqual({ measurementId: null, consentRequired: false });
    await expect(svc.saveSettings({ measurementId: 'UA-123-1' }, 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await svc.saveSettings({ measurementId: ' g-ab12cd34ef ' }, 'a1');
    expect((await svc.getPublicConfig('DE')).data).toEqual({ measurementId: 'G-AB12CD34EF', consentRequired: true });
    await svc.saveSettings({ enabled: false }, 'a1');
    expect((await svc.getPublicConfig('PK')).data.measurementId).toBeNull();
    const s = (await svc.getSettings()).data;
    expect(s).toMatchObject({ measurementId: 'G-AB12CD34EF', enabled: false, ga4: { connected: true } });
  });

  it('suggests the measurement id of the connected property\'s web stream', async () => {
    const { svc, setReply } = setup();
    setReply((url) => (url.endsWith('/properties/42/dataStreams') ? { json: { dataStreams: [{ type: 'ANDROID_APP_DATA_STREAM' }, { webStreamData: { measurementId: 'G-WEB1234' } }] } } : { json: {} }));
    expect((await svc.getSettings()).data.detectedMeasurementId).toBe('G-WEB1234');
  });

  it('builds the overview with every day filled in and changes against the previous period, and caches it', async () => {
    const { svc, calls, setReply } = setup();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const m = ['totalUsers', 'newUsers', 'sessions', 'screenPageViews', 'averageSessionDuration', 'engagementRate'];
    setReply(() => ({
      json: {
        reports: [
          { dimensionHeaders: [{ name: 'date' }], metricHeaders: m.slice(0, 4).map((name) => ({ name })), rows: [{ dimensionValues: [{ value: today }], metricValues: [{ value: '10' }, { value: '4' }, { value: '12' }, { value: '30' }] }] },
          totalsReport(m, [150, 60, 200, 500, 95.5, 0.61]),
          totalsReport(m, [100, 50, 160, 400, 80, 0.5]),
        ],
      },
    }));
    const out = (await svc.overview('7d')).data;
    expect(calls[0].url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/42:batchRunReports');
    expect(calls[0].body.requests[1].dateRanges).toEqual([{ startDate: '6daysAgo', endDate: 'today' }]);
    expect(out.series).toHaveLength(7);
    expect(out.series[6]).toMatchObject({ users: 10, newUsers: 4, sessions: 12, pageViews: 30 });
    expect(out.series[0]).toMatchObject({ users: 0, sessions: 0 });
    expect(out.totals.users).toEqual({ value: 150, previous: 100, change: 50 });
    expect(out.totals.engagementRate.value).toBe(0.61);
    await svc.overview('7d');
    expect(calls).toHaveLength(1); // served from the 10-minute cache
  });

  it('builds the funnel from one filtered report per step', async () => {
    const { svc, calls, setReply } = setup();
    setReply(() => ({ json: { reports: [1000, 300, 60, 40, 25].map((v) => totalsReport(['totalUsers'], [v])) } }));
    const out = (await svc.funnel('28d')).data;
    const filters = calls[0].body.requests.map((r: any) => r.dimensionFilter?.filter ?? null);
    expect(filters[0]).toBeNull();
    expect(filters[1]).toMatchObject({ fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/pricing' } });
    expect(filters.slice(2).map((f: any) => f.stringFilter.value)).toEqual(['sign_up_start', 'sign_up', 'store_created']);
    expect(out.steps.map((s: any) => [s.key, s.users, s.fromPrevious, s.fromStart])).toEqual([
      ['visited', 1000, null, null], ['pricing', 300, 30, 30], ['sign_up_start', 60, 20, 6], ['sign_up', 40, 66.7, 4], ['store_created', 25, 62.5, 2.5],
    ]);
  });

  it('drops GA4 "(not set)" rows and reads realtime visitors', async () => {
    const { svc, setReply } = setup();
    setReply((url) => url.endsWith(':runRealtimeReport')
      ? { json: { dimensionHeaders: [{ name: 'country' }], metricHeaders: [{ name: 'activeUsers' }], rows: [{ dimensionValues: [{ value: 'Pakistan' }], metricValues: [{ value: '3' }] }, { dimensionValues: [{ value: '(not set)' }], metricValues: [{ value: '1' }] }], totals: [{ metricValues: [{ value: '4' }] }] } }
      : { json: {} });
    const out = (await svc.realtime()).data;
    expect(out.activeUsers).toBe(4);
    expect(out.countries).toEqual([{ country: 'Pakistan', users: 3 }]);
  });

  it('explains what to do when GA4 is not connected, and flags a refused token for reconnection', async () => {
    await expect(setup({ connected: false }).svc.overview('7d')).rejects.toThrow('SEO → Integrations');
    const { svc, integrations, setReply } = setup();
    setReply(() => ({ status: 403, json: { error: { message: 'User does not have sufficient permissions for this property.' } } }));
    await expect(svc.content('28d')).rejects.toThrow('Reconnect it');
    expect(integrations.markPlatformGa4NeedsReauth).toHaveBeenCalledWith('User does not have sufficient permissions for this property.');
  });
});
