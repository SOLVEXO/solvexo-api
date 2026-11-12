/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SeoIntegrationsService } from '../seo/services/seo-integrations.service';
import { JWT } from 'google-auth-library';
import { SiteAnalyticsSettings, SiteAnalyticsSettingsDocument } from './schemas/site-analytics-settings.schema';
import { GaEnv, readGaEnv, ServiceAccountKey } from './site-analytics.env';
import {
  change, consentRequired, dateRanges, Ga4Report, isNotSet, isoDay, lastDays, MEASUREMENT_ID_RE, rangeDays,
  reportRows, reportTotals, SiteRange,
} from './site-analytics.util';

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const CACHE_MS = 10 * 60_000;
const REALTIME_CACHE_MS = 30_000;
const NOT_CONNECTED =
  'Google Analytics reports are not connected. Set GA4_SERVICE_ACCOUNT_JSON (and GA4_PROPERTY_ID) in the API server environment, or connect Google Analytics in Super Admin → SEO → Integrations.';

/** Funnel steps, in order. The web app sends the three events from the sign-up and onboarding pages. */
export const FUNNEL_STEPS = [
  { key: 'visited', label: 'Visited the site' },
  { key: 'pricing', label: 'Viewed pricing', pagePrefix: '/pricing' },
  { key: 'sign_up_start', label: 'Started sign-up', event: 'sign_up_start' },
  { key: 'sign_up', label: 'Created an account', event: 'sign_up' },
  { key: 'store_created', label: 'Created a store', event: 'store_created' },
] as const;

/** The store setup wizard's steps (`/onboard?step=…`), in order. Each is a page view, so no extra events are needed. */
export const SETUP_STEPS = [
  { key: 'store_info', label: 'Store details', slug: 'store-info' },
  { key: 'checkout', label: 'Plan or free trial', slug: 'checkout' },
  { key: 'seller_type', label: 'Seller type', slug: 'seller-type' },
  { key: 'what_you_sell', label: 'What you sell', slug: 'what-you-sell' },
  { key: 'store_created', label: 'Store created', event: 'store_created' },
] as const;

/**
 * Solvexo's own website visitors, from Google Analytics 4.
 * - The public site loads the GA tag with the measurement id saved here (`getPublicConfig`).
 * - Reports read the GA4 Data API through the platform GA4 connection the SEO module already manages.
 */
@Injectable()
export class SiteAnalyticsService {
  private readonly logger = new Logger(SiteAnalyticsService.name);
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  /** Overridable in tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  /** Server environment (VPS .env); overridable in tests. */
  envImpl: () => GaEnv = () => readGaEnv();
  /** Access token for a service account (Analytics read-only); overridable in tests. */
  serviceAccountTokenImpl = async (key: ServiceAccountKey): Promise<string> => {
    let client = this.jwtClients.get(key.client_email);
    if (!client) {
      client = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
      this.jwtClients.set(key.client_email, client);
    }
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Google did not return an access token for the service account');
    return token;
  };
  private readonly jwtClients = new Map<string, JWT>();

  constructor(
    private readonly integrations: SeoIntegrationsService,
    @InjectModel(SiteAnalyticsSettings.name) private readonly settingsModel: Model<SiteAnalyticsSettingsDocument>,
  ) {}

  // ── Settings ────────────────────────────────────────────────────────────────

  private async settings() {
    return (await this.settingsModel.findOne({ key: 'platform' }).lean()) ?? { measurementId: null, enabled: true };
  }

  /** The measurement id the public site actually loads (saved setting first, then the server environment). */
  private async activeMeasurementId(): Promise<string | null> {
    const s = await this.settings();
    return s.measurementId || this.envImpl().measurementId?.value || null;
  }

  /** What the public site needs: the id to load (null = don't track) and whether to ask for consent first. */
  async getPublicConfig(country: string | null) {
    const s = await this.settings();
    const id = s.measurementId || this.envImpl().measurementId?.value || null;
    return {
      success: true,
      data: {
        measurementId: s.enabled !== false && id ? id : null,
        /** False when an admin switched tracking off (the web app must not fall back to a build-time id then). */
        enabled: s.enabled !== false,
        consentRequired: consentRequired(country),
      },
    };
  }

  /**
   * Settings plus where each value comes from. With `check`, also makes one small live request to Google so the
   * page can say exactly what is wrong (no access, wrong property, bad key) instead of failing later.
   */
  async getSettings(check = false) {
    const [s, sso] = await Promise.all([this.settings(), this.integrations.platformGa4Status()]);
    const env = this.envImpl();
    const sa = env.serviceAccount;
    const source: 'service_account' | 'google_sign_in' | null = sa ? 'service_account' : sso.connected ? 'google_sign_in' : null;
    let propertyId = sa ? env.propertyId?.value ?? null : sso.propertyId;
    let lastError = sa ? null : sso.lastError;
    let ok: boolean | null = null;
    if (check && source) {
      try {
        const access = await this.access();
        propertyId = access?.propertyId ?? propertyId;
        await this.call('runRealtimeReport', { metrics: [{ name: 'activeUsers' }] });
        ok = true;
        lastError = null;
        // The Google sign-in path reads the property chosen on the SEO page: check it holds the site's stream too.
        const mid = await this.activeMeasurementId();
        if (access && access.source === 'google_sign_in' && mid) {
          const ids = await this.streamIds(access.accessToken, access.propertyId).catch(() => null);
          this.propertyNote = ids && !ids.includes(mid)
            ? `The site sends visits to ${mid}, but the connected property ${access.propertyId} only has ${ids.length ? ids.join(', ') : 'no web streams'}, so its reports stay empty. Pick the property that owns ${mid} in Super Admin → SEO → Integrations.`
            : null;
        }
      } catch (e: any) {
        ok = false;
        lastError = e?.response?.message ?? e?.message ?? 'Google Analytics request failed';
      }
    }
    const envMeasurementId = env.measurementId?.value ?? null;
    let detectedMeasurementId: string | null = null;
    if (!s.measurementId && !envMeasurementId && source) detectedMeasurementId = await this.detectMeasurementId().catch(() => null);
    return {
      success: true,
      data: {
        measurementId: s.measurementId || envMeasurementId,
        measurementIdSource: s.measurementId ? 'settings' : envMeasurementId ? `env:${env.measurementId!.variable}` : null,
        enabled: s.enabled !== false,
        ga4: {
          connected: !!source && ok !== false,
          source,
          status: source === 'service_account' ? (ok === false ? 'error' : 'connected') : sso.status,
          propertyId,
          lastError,
          ok,
          serviceAccountEmail: sa?.key.client_email ?? null,
        },
        env: {
          measurementIdVariable: env.measurementId?.variable ?? null,
          propertyIdVariable: env.propertyId?.variable ?? null,
          serviceAccountVariable: sa?.variable ?? null,
          problems: this.propertyNote ? [...env.problems, this.propertyNote] : env.problems,
        },
        detectedMeasurementId,
      },
    };
  }

  async saveSettings(input: { measurementId?: string; enabled?: boolean }, adminId: string | null) {
    const set: Record<string, unknown> = { updatedByAdminId: adminId };
    if (input.measurementId !== undefined) {
      const id = input.measurementId.trim().toUpperCase();
      if (id && !MEASUREMENT_ID_RE.test(id)) {
        throw new BadRequestException('The measurement ID looks like G-XXXXXXXXXX (Google Analytics → Admin → Data streams).');
      }
      set.measurementId = id || null;
    }
    if (input.enabled !== undefined) set.enabled = input.enabled;
    await this.settingsModel.updateOne({ key: 'platform' }, { $set: set, $setOnInsert: { key: 'platform' } }, { upsert: true });
    return this.getSettings();
  }

  /** The measurement id of the connected property's first web stream, so the admin doesn't have to look it up. */
  private async detectMeasurementId(): Promise<string | null> {
    const cached = this.cached<string | null>('detect', CACHE_MS);
    if (cached !== undefined) return cached;
    const access = await this.access();
    if (!access) return null;
    const res = await this.fetchImpl(`${ADMIN_API}/${access.propertyId}/dataStreams`, {
      headers: { Authorization: `Bearer ${access.accessToken}` },
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const id = (body?.dataStreams ?? []).map((d: any) => d?.webStreamData?.measurementId).find((m: unknown) => MEASUREMENT_ID_RE.test(String(m ?? ''))) ?? null;
    return this.remember('detect', id);
  }

  // ── Reports ─────────────────────────────────────────────────────────────────

  /** Users, new users, sessions and page views per day, with totals compared to the previous period. */
  async overview(range: SiteRange) {
    return this.report(`overview:${range}`, CACHE_MS, async () => {
      const { current, previous } = dateRanges(range);
      const metrics = ['totalUsers', 'newUsers', 'sessions', 'screenPageViews', 'averageSessionDuration', 'engagementRate'];
      const [series, cur, prev] = await this.batch([
        { dateRanges: [current], dimensions: [{ name: 'date' }], metrics: metrics.slice(0, 4).map((name) => ({ name })), orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
        { dateRanges: [current], metrics: metrics.map((name) => ({ name })) },
        { dateRanges: [previous], metrics: metrics.map((name) => ({ name })) },
      ]);
      const byDay = new Map(reportRows(series).map((r) => [String(r.date), r]));
      const now = reportTotals(cur);
      const before = reportTotals(prev);
      return {
        range,
        series: lastDays(rangeDays(range)).map((d) => {
          const r = byDay.get(d);
          return { date: isoDay(d), users: num(r?.totalUsers), newUsers: num(r?.newUsers), sessions: num(r?.sessions), pageViews: num(r?.screenPageViews) };
        }),
        totals: Object.fromEntries(
          [
            ['users', 'totalUsers'], ['newUsers', 'newUsers'], ['sessions', 'sessions'], ['pageViews', 'screenPageViews'],
            ['avgSessionSeconds', 'averageSessionDuration'], ['engagementRate', 'engagementRate'],
          ].map(([k, m]) => [k, { value: round(now[m]), previous: round(before[m]), change: change(now[m] ?? 0, before[m] ?? 0) }]),
        ),
      };
    });
  }

  /** Where visitors come from: channels, source / medium and campaigns. */
  async acquisition(range: SiteRange) {
    return this.report(`acquisition:${range}`, CACHE_MS, async () => {
      const { current } = dateRanges(range);
      const metrics = [{ name: 'sessions' }, { name: 'totalUsers' }];
      const order = [{ metric: { metricName: 'sessions' }, desc: true }];
      const [channels, sources, campaigns] = await this.batch([
        { dateRanges: [current], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [...metrics, { name: 'engagementRate' }], orderBys: order, limit: 20 },
        { dateRanges: [current], dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }], metrics, orderBys: order, limit: 15 },
        { dateRanges: [current], dimensions: [{ name: 'sessionCampaignName' }], metrics, orderBys: order, limit: 15 },
      ]);
      return {
        range,
        channels: reportRows(channels).map((r) => ({ channel: String(r.sessionDefaultChannelGroup || 'Unassigned'), sessions: num(r.sessions), users: num(r.totalUsers), engagementRate: round(num(r.engagementRate)) })),
        sources: reportRows(sources).map((r) => ({ source: String(r.sessionSource || '(direct)'), medium: String(r.sessionMedium || '(none)'), sessions: num(r.sessions), users: num(r.totalUsers) })),
        campaigns: reportRows(campaigns).filter((r) => !isNotSet(r.sessionCampaignName)).slice(0, 10).map((r) => ({ campaign: String(r.sessionCampaignName), sessions: num(r.sessions), users: num(r.totalUsers) })),
      };
    });
  }

  /** Top pages, landing pages, countries, cities and devices. */
  async content(range: SiteRange) {
    return this.report(`content:${range}`, CACHE_MS, async () => {
      const { current } = dateRanges(range);
      const byUsers = [{ metric: { metricName: 'totalUsers' }, desc: true }];
      const [pages, landing, countries, cities, devices] = await this.batch([
        { dateRanges: [current], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 15 },
        { dateRanges: [current], dimensions: [{ name: 'landingPage' }], metrics: [{ name: 'sessions' }, { name: 'engagementRate' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 15 },
        { dateRanges: [current], dimensions: [{ name: 'country' }], metrics: [{ name: 'totalUsers' }, { name: 'sessions' }], orderBys: byUsers, limit: 15 },
        { dateRanges: [current], dimensions: [{ name: 'city' }, { name: 'country' }], metrics: [{ name: 'totalUsers' }], orderBys: byUsers, limit: 15 },
        { dateRanges: [current], dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'totalUsers' }, { name: 'sessions' }], orderBys: byUsers },
      ]);
      return {
        range,
        pages: reportRows(pages).map((r) => ({ path: String(r.pagePath), views: num(r.screenPageViews), users: num(r.totalUsers) })),
        landingPages: reportRows(landing).filter((r) => !isNotSet(r.landingPage)).slice(0, 10).map((r) => ({ path: String(r.landingPage), sessions: num(r.sessions), engagementRate: round(num(r.engagementRate)) })),
        countries: reportRows(countries).filter((r) => !isNotSet(r.country)).map((r) => ({ country: String(r.country), users: num(r.totalUsers), sessions: num(r.sessions) })),
        cities: reportRows(cities).filter((r) => !isNotSet(r.city)).slice(0, 10).map((r) => ({ city: String(r.city), country: String(r.country), users: num(r.totalUsers) })),
        devices: reportRows(devices).map((r) => ({ device: String(r.deviceCategory), users: num(r.totalUsers), sessions: num(r.sessions) })),
      };
    });
  }

  /** Visitors in the last 30 minutes, by page and country. */
  async realtime() {
    return this.report('realtime', REALTIME_CACHE_MS, async () => {
      const [pages, countries] = await Promise.all([
        this.call('runRealtimeReport', { dimensions: [{ name: 'unifiedScreenName' }], metrics: [{ name: 'activeUsers' }], metricAggregations: ['TOTAL'], limit: 10 }),
        this.call('runRealtimeReport', { dimensions: [{ name: 'country' }], metrics: [{ name: 'activeUsers' }], limit: 10 }),
      ]);
      return {
        activeUsers: reportTotals(pages).activeUsers ?? 0,
        pages: reportRows(pages).map((r) => ({ title: String(r.unifiedScreenName), users: num(r.activeUsers) })),
        countries: reportRows(countries).filter((r) => !isNotSet(r.country)).map((r) => ({ country: String(r.country), users: num(r.activeUsers) })),
      };
    });
  }

  /** Visit → pricing → sign-up started → account → store, as users per step. */
  async funnel(range: SiteRange) {
    return this.report(`funnel:${range}`, CACHE_MS, async () => {
      const { current } = dateRanges(range);
      const reports = await this.batch(
        FUNNEL_STEPS.map((step) => ({
          dateRanges: [current],
          metrics: [{ name: 'totalUsers' }],
          ...('pagePrefix' in step
            ? { dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: step.pagePrefix } } } }
            : 'event' in step
              ? { dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: step.event } } } }
              : {}),
        })),
      );
      const users = reports.map((r) => reportTotals(r).totalUsers ?? 0);
      return {
        range,
        steps: FUNNEL_STEPS.map((step, i) => ({
          key: step.key,
          label: step.label,
          users: users[i],
          fromPrevious: i === 0 ? null : pct(users[i], users[i - 1]),
          fromStart: i === 0 ? null : pct(users[i], users[0]),
        })),
      };
    });
  }

  /** Users who reached each store setup step, to show where sign-ups stop before a store exists. */
  async setupSteps(range: SiteRange) {
    return this.report(`setup:${range}`, CACHE_MS, async () => {
      const { current } = dateRanges(range);
      const reports = await this.batch(
        SETUP_STEPS.map((step) => ({
          dateRanges: [current],
          metrics: [{ name: 'totalUsers' }],
          dimensionFilter: 'event' in step
            ? { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: step.event } } }
            : { filter: { fieldName: 'pagePathPlusQueryString', stringFilter: { matchType: 'CONTAINS', value: `onboard?step=${step.slug}` } } },
        })),
      );
      const users = reports.map((r) => reportTotals(r).totalUsers ?? 0);
      return {
        range,
        steps: SETUP_STEPS.map((step, i) => ({
          key: step.key,
          label: step.label,
          users: users[i],
          fromPrevious: i === 0 ? null : pct(users[i], users[i - 1]),
          fromStart: i === 0 ? null : pct(users[i], users[0]),
        })),
      };
    });
  }

  // ── GA4 Data API ────────────────────────────────────────────────────────────

  private async report<T>(key: string, ttl: number, build: () => Promise<T>) {
    const hit = this.cached<T>(key, ttl);
    if (hit !== undefined) return { success: true, data: hit };
    return { success: true, data: this.remember(key, await build()) };
  }

  private cached<T>(key: string, ttl: number): T | undefined {
    const c = this.cache.get(key);
    return c && Date.now() - c.at < ttl ? (c.value as T) : undefined;
  }

  private remember<T>(key: string, value: T): T {
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async batch(requests: Record<string, unknown>[]): Promise<Ga4Report[]> {
    const body: any = await this.call('batchRunReports', { requests });
    return body?.reports ?? [];
  }

  /** Who reads the reports: the service account from the server environment, else the SEO page's Google sign-in. */
  private async access(): Promise<{ accessToken: string; propertyId: string; source: 'service_account' | 'google_sign_in'; email?: string } | null> {
    const env = this.envImpl();
    if (env.serviceAccount) {
      const { key } = env.serviceAccount;
      let accessToken: string;
      try {
        accessToken = await this.serviceAccountTokenImpl(key);
      } catch (e: any) {
        throw new BadRequestException(`Google refused the service account key (${key.client_email}): ${e?.message ?? 'sign-in failed'}. Check the JSON key in the server environment.`);
      }
      const measurementId = await this.activeMeasurementId();
      const propertyId = await this.reportingProperty(accessToken, key.client_email, env.propertyId?.value ?? null, measurementId);
      return { accessToken, propertyId, source: 'service_account', email: key.client_email };
    }
    const sso = await this.integrations.platformGa4Access().catch(() => {
      throw new BadRequestException('Google Analytics access has expired. Reconnect it in Super Admin → SEO → Integrations.');
    });
    return sso ? { ...sso, source: 'google_sign_in' } : null;
  }

  /** Measurement ids of a property's web streams (null when Google won't list them). */
  private async streamIds(accessToken: string, property: string): Promise<string[] | null> {
    const key = `streams:${property}`;
    const cached = this.cached<string[] | null>(key, CACHE_MS);
    if (cached !== undefined) return cached;
    const r = await this.fetchImpl(`${ADMIN_API}/${property}/dataStreams`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    const body: any = await r.json().catch(() => ({}));
    const ids = (body?.dataStreams ?? []).map((d: any) => String(d?.webStreamData?.measurementId ?? '')).filter((m: string) => MEASUREMENT_ID_RE.test(m));
    return this.remember(key, ids);
  }

  /** Why reports may stay empty although the site is tracked (shown on the Visitors page); null when all is well. */
  private propertyNote: string | null = null;

  /**
   * The property to read reports from: the one whose web stream is the measurement id the site sends visits to.
   * A configured GA4_PROPERTY_ID is used when it holds that stream; when it doesn't, the property that does is used
   * instead (and the Visitors page says so), because reading a property the site never sends to only ever shows 0.
   */
  private async reportingProperty(accessToken: string, email: string, configured: string | null, measurementId: string | null): Promise<string> {
    const cacheKey = `property:${email}:${configured ?? '-'}:${measurementId ?? '-'}`;
    const cached = this.cached<{ property: string; note: string | null }>(cacheKey, CACHE_MS);
    if (cached) { this.propertyNote = cached.note; return cached.property; }

    let property = configured;
    let note: string | null = null;
    if (configured && measurementId) {
      const ids = await this.streamIds(accessToken, configured).catch(() => null);
      if (ids && !ids.includes(measurementId)) {
        const match = await this.findPropertyFor(accessToken, email, measurementId).catch(() => null);
        if (match?.property) {
          note = `GA4_PROPERTY_ID is ${configured}, but the site sends visits to ${measurementId}, which belongs to ${match.property}. Reports are read from ${match.property}; update GA4_PROPERTY_ID to ${match.property.replace('properties/', '')}.`;
          property = match.property;
        } else {
          note = `The site sends visits to ${measurementId}, but ${configured} only has ${ids.length ? ids.join(', ') : 'no web streams'}, so its reports stay empty. Use the measurement ID of ${configured}'s web stream, or give ${email} Viewer access to the property that owns ${measurementId}.`;
        }
      }
    }
    if (!property) {
      const match = await this.findPropertyFor(accessToken, email, measurementId);
      property = match.property ?? match.first;
      if (measurementId && !match.property) {
        note = `None of the Google Analytics properties ${email} can see has a web stream with ${measurementId}, so reports read ${property} and stay empty. In Google Analytics → Admin → Property access management of the property that owns ${measurementId}, add ${email} as Viewer.`;
      }
    }
    if (note) this.logger.warn(note);
    this.propertyNote = note;
    this.remember(cacheKey, { property, note });
    return property;
  }

  /** Lists the properties the account can see; `property` is the one owning `measurementId` (if any). */
  private async findPropertyFor(accessToken: string, email: string, measurementId: string | null): Promise<{ property: string | null; first: string }> {
    const res = await this.fetchImpl(`${ADMIN_API}/accountSummaries?pageSize=200`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BadRequestException(`Could not list Google Analytics properties for ${email}: ${body?.error?.message ?? `HTTP ${res.status}`}. Enable the "Google Analytics Admin API" for the key's Google Cloud project, or set GA4_PROPERTY_ID.`);
    }
    const properties: string[] = (body?.accountSummaries ?? []).flatMap((a: any) => (a?.propertySummaries ?? []).map((p: any) => String(p?.property ?? ''))).filter((p: string) => /^properties\/\d+$/.test(p));
    if (!properties.length) {
      throw new BadRequestException(`The service account ${email} has no access to any Google Analytics property. In Google Analytics → Admin → Property access management, add it with the Viewer role.`);
    }
    if (measurementId) {
      for (const p of properties.slice(0, 20)) {
        const ids = await this.streamIds(accessToken, p).catch(() => null);
        if (ids?.includes(measurementId)) return { property: p, first: properties[0] };
      }
    }
    return { property: null, first: properties[0] };
  }

  private async call(method: 'batchRunReports' | 'runRealtimeReport', payload: Record<string, unknown>): Promise<any> {
    const access = await this.access();
    if (!access) throw new BadRequestException(NOT_CONNECTED);
    const res = await this.fetchImpl(`${DATA_API}/${access.propertyId}:${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const message = String(body?.error?.message ?? `HTTP ${res.status}`);
    this.logger.warn(`GA4 ${method} failed (${access.source}, ${access.propertyId}): ${message}`);
    if (access.source === 'service_account') {
      if (res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
        throw new BadRequestException(`The Google Analytics Data API is not enabled for the service account's Google Cloud project. Enable "Google Analytics Data API" in Google Cloud Console, then try again. (${message})`);
      }
      if (res.status === 403 || res.status === 401) {
        throw new BadRequestException(`Google Analytics refused access to ${access.propertyId} for ${access.email}. In Google Analytics → Admin → Property access management, add that email with the Viewer role. (${message})`);
      }
      throw new BadRequestException(`Google Analytics: ${message}`);
    }
    if (res.status === 401 || res.status === 403) {
      await this.integrations.markPlatformGa4NeedsReauth(message);
      throw new BadRequestException('Google Analytics refused access. Reconnect it in Super Admin → SEO → Integrations.');
    }
    throw new BadRequestException(`Google Analytics: ${message}`);
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const round = (v: number | undefined) => Math.round((v ?? 0) * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
