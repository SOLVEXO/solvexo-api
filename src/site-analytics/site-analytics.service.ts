/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SeoIntegrationsService } from '../seo/services/seo-integrations.service';
import { SiteAnalyticsSettings, SiteAnalyticsSettingsDocument } from './schemas/site-analytics-settings.schema';
import {
  change, consentRequired, dateRanges, Ga4Report, isNotSet, isoDay, lastDays, MEASUREMENT_ID_RE, rangeDays,
  reportRows, reportTotals, SiteRange,
} from './site-analytics.util';

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const CACHE_MS = 10 * 60_000;
const REALTIME_CACHE_MS = 30_000;
const NOT_CONNECTED =
  'Connect Solvexo\'s Google Analytics property first: Super Admin → SEO → Integrations → Google Analytics.';

/** Funnel steps, in order. The web app sends the three events from the sign-up and onboarding pages. */
export const FUNNEL_STEPS = [
  { key: 'visited', label: 'Visited the site' },
  { key: 'pricing', label: 'Viewed pricing', pagePrefix: '/pricing' },
  { key: 'sign_up_start', label: 'Started sign-up', event: 'sign_up_start' },
  { key: 'sign_up', label: 'Created an account', event: 'sign_up' },
  { key: 'store_created', label: 'Created a store', event: 'store_created' },
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

  constructor(
    private readonly integrations: SeoIntegrationsService,
    @InjectModel(SiteAnalyticsSettings.name) private readonly settingsModel: Model<SiteAnalyticsSettingsDocument>,
  ) {}

  // ── Settings ────────────────────────────────────────────────────────────────

  private async settings() {
    return (await this.settingsModel.findOne({ key: 'platform' }).lean()) ?? { measurementId: null, enabled: true };
  }

  /** What the public site needs: the id to load (null = don't track) and whether to ask for consent first. */
  async getPublicConfig(country: string | null) {
    const s = await this.settings();
    return {
      success: true,
      data: {
        measurementId: s.enabled !== false && s.measurementId ? s.measurementId : null,
        consentRequired: consentRequired(country),
      },
    };
  }

  async getSettings() {
    const [s, ga4] = await Promise.all([this.settings(), this.integrations.platformGa4Status()]);
    let detectedMeasurementId: string | null = null;
    if (!s.measurementId && ga4.connected) detectedMeasurementId = await this.detectMeasurementId().catch(() => null);
    return {
      success: true,
      data: { measurementId: s.measurementId ?? null, enabled: s.enabled !== false, ga4, detectedMeasurementId },
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
    const access = await this.integrations.platformGa4Access();
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

  private async call(method: 'batchRunReports' | 'runRealtimeReport', payload: Record<string, unknown>): Promise<any> {
    const access = await this.integrations.platformGa4Access().catch(() => {
      throw new BadRequestException('Google Analytics access has expired. Reconnect it in Super Admin → SEO → Integrations.');
    });
    if (!access) throw new BadRequestException(NOT_CONNECTED);
    const res = await this.fetchImpl(`${DATA_API}/${access.propertyId}:${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const message = String(body?.error?.message ?? `HTTP ${res.status}`);
    this.logger.warn(`GA4 ${method} failed: ${message}`);
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
