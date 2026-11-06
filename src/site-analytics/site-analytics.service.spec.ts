/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { SiteAnalyticsService } from './site-analytics.service';

function setup(opts: { connected?: boolean; env?: any } = {}) {
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
  svc.envImpl = () => opts.env ?? { measurementId: null, propertyId: null, serviceAccount: null, problems: [] };
  svc.serviceAccountTokenImpl = jest.fn(async () => 'sa-token');
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
    expect((await svc.getPublicConfig('PK')).data).toEqual({ measurementId: null, consentRequired: false, enabled: true });
    await expect(svc.saveSettings({ measurementId: 'UA-123-1' }, 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await svc.saveSettings({ measurementId: ' g-ab12cd34ef ' }, 'a1');
    expect((await svc.getPublicConfig('DE')).data).toEqual({ measurementId: 'G-AB12CD34EF', consentRequired: true, enabled: true });
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

  describe('with a service account in the server environment', () => {
    const key = { client_email: 'ga@solvexo.iam.gserviceaccount.com', private_key: 'k' };
    const env = (over: any = {}) => ({ measurementId: { value: 'G-ENV12345', variable: 'GA_MEASUREMENT_ID' }, propertyId: null, serviceAccount: { key, variable: 'GA4_SERVICE_ACCOUNT_JSON' }, problems: [], ...over });

    it('loads the measurement id from the environment when none is saved', async () => {
      const { svc } = setup({ connected: false, env: env() });
      expect((await svc.getPublicConfig('PK')).data.measurementId).toBe('G-ENV12345');
    });

    it('finds the property the service account can see, reads reports with it, and reports success', async () => {
      const { svc, calls, setReply, integrations } = setup({ connected: false, env: env() });
      setReply((url) => url.includes('accountSummaries')
        ? { json: { accountSummaries: [{ propertySummaries: [{ property: 'properties/111' }, { property: 'properties/222' }] }] } }
        : url.includes('/properties/111/dataStreams') ? { json: { dataStreams: [{ webStreamData: { measurementId: 'G-OTHER999' } }] } }
          : url.includes('/properties/222/dataStreams') ? { json: { dataStreams: [{ webStreamData: { measurementId: 'G-ENV12345' } }] } }
            : { json: { metricHeaders: [{ name: 'activeUsers' }], rows: [{ metricValues: [{ value: '3' }] }] } });
      const s = (await svc.getSettings(true)).data;
      expect(s.ga4).toMatchObject({ connected: true, ok: true, source: 'service_account', propertyId: 'properties/222', serviceAccountEmail: key.client_email });
      expect(s.measurementIdSource).toBe('env:GA_MEASUREMENT_ID');
      expect(calls.at(-1)!.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/222:runRealtimeReport');
      expect(integrations.platformGa4Access).not.toHaveBeenCalled();
    });

    it('says exactly what to fix when Google refuses the service account', async () => {
      const { svc, setReply, integrations } = setup({ connected: false, env: env({ propertyId: { value: 'properties/412', variable: 'GA4_PROPERTY_ID' } }) });
      setReply(() => ({ status: 403, json: { error: { message: 'User does not have sufficient permissions for this property.' } } }));
      const s = (await svc.getSettings(true)).data;
      expect(s.ga4.ok).toBe(false);
      expect(s.ga4.connected).toBe(false);
      expect(s.ga4.lastError).toContain('add that email with the Viewer role');
      expect(s.ga4.lastError).toContain(key.client_email);
      expect(integrations.markPlatformGa4NeedsReauth).not.toHaveBeenCalled();

      setReply(() => ({ status: 403, json: { error: { message: 'Google Analytics Data API has not been used in project 123 before or it is disabled.' } } }));
      await expect(svc.overview('7d')).rejects.toThrow('Enable "Google Analytics Data API"');

      svc.serviceAccountTokenImpl = jest.fn(async () => { throw new Error('invalid_grant: Invalid JWT Signature.'); });
      await expect(svc.overview('28d')).rejects.toThrow('Google refused the service account key');
    });

    // The bug behind an empty Visitors page: reports read a property the site never sends visits to.
    const twoProperties = (realtime = 3) => (url: string) => url.includes('accountSummaries')
      ? { json: { accountSummaries: [{ propertySummaries: [{ property: 'properties/111' }, { property: 'properties/222' }] }] } }
      : url.includes('/properties/111/dataStreams') ? { json: { dataStreams: [{ webStreamData: { measurementId: 'G-OTHER999' } }] } }
        : url.includes('/properties/222/dataStreams') ? { json: { dataStreams: [{ webStreamData: { measurementId: 'G-SAVED777' } }] } }
          : { json: { metricHeaders: [{ name: 'activeUsers' }], rows: [{ metricValues: [{ value: String(realtime) }] }] } };

    it('uses the property that owns the measurement id saved in Super Admin, not just the first one it can see', async () => {
      const { svc, calls, setReply } = setup({ connected: false, env: env({ measurementId: null }) });
      await svc.saveSettings({ measurementId: 'G-SAVED777' }, 'a1');
      setReply(twoProperties());
      const s = (await svc.getSettings(true)).data;
      expect(s.ga4.propertyId).toBe('properties/222');
      expect(calls.at(-1)!.url).toContain('/properties/222:runRealtimeReport');
      expect(s.env.problems).toEqual([]);
    });

    it('reads the right property and says so when GA4_PROPERTY_ID points at a property without the site\'s stream', async () => {
      const { svc, calls, setReply } = setup({ connected: false, env: env({ measurementId: null, propertyId: { value: 'properties/111', variable: 'GA4_PROPERTY_ID' } }) });
      await svc.saveSettings({ measurementId: 'G-SAVED777' }, 'a1');
      setReply(twoProperties());
      const s = (await svc.getSettings(true)).data;
      expect(s.ga4.propertyId).toBe('properties/222');
      expect(calls.at(-1)!.url).toContain('/properties/222:runRealtimeReport');
      expect(s.env.problems.join(' ')).toContain('update GA4_PROPERTY_ID to 222');
    });

    it('explains an id that no visible property owns', async () => {
      const { svc, setReply } = setup({ connected: false, env: env({ measurementId: null }) });
      await svc.saveSettings({ measurementId: 'G-NOWHERE1' }, 'a1');
      setReply(twoProperties());
      const s = (await svc.getSettings(true)).data;
      expect(s.env.problems.join(' ')).toContain('has a web stream with G-NOWHERE1');
    });

    it('explains a service account without access to any property', async () => {
      const { svc, setReply } = setup({ connected: false, env: env() });
      setReply(() => ({ json: { accountSummaries: [] } }));
      await expect(svc.funnel('28d')).rejects.toThrow('has no access to any Google Analytics property');
    });
  });
});
