import { BadRequestException } from '@nestjs/common';

export type DashboardScope = 'store' | 'admin';
export type WidgetSize = 'small' | 'third' | 'medium' | 'large' | 'full';

type SettingSpec = { type: 'enum'; values: readonly string[] } | { type: 'int'; min: number; max: number };
interface WidgetSpec { sizes: readonly WidgetSize[]; settings?: Record<string, SettingSpec> }

const RANGES = ['7d', '30d', '90d', '6m', '12m'] as const;
const LIMIT = { type: 'int', min: 3, max: 20 } as const;
const SMALL_MEDIUM: readonly WidgetSize[] = ['small', 'medium'];
const WIDE: readonly WidgetSize[] = ['medium', 'large', 'full'];

/** Widgets a merchant can place on the Store Dashboard. Keep ids in sync with solvexo-web
 *  `features/seller/store/Dashboard/storeDashboardWidgets.tsx` (no shared package between the two projects). */
export const STORE_WIDGETS: Record<string, WidgetSpec> = {
  'metric.revenue_30d': { sizes: SMALL_MEDIUM },
  'metric.orders_30d': { sizes: SMALL_MEDIUM },
  'metric.active_products': { sizes: SMALL_MEDIUM },
  'metric.customers_30d': { sizes: SMALL_MEDIUM },
  'metric.avg_order_value_30d': { sizes: SMALL_MEDIUM },
  'metric.refund_rate_30d': { sizes: SMALL_MEDIUM },
  'metric.repeat_buyer_rate_30d': { sizes: SMALL_MEDIUM },
  'metric.today_revenue': { sizes: SMALL_MEDIUM },
  'metric.today_orders': { sizes: SMALL_MEDIUM },
  'metric.today_avg_order_value': { sizes: SMALL_MEDIUM },
  'metric.conversion_rate': { sizes: SMALL_MEDIUM },
  sales_chart: { sizes: WIDE, settings: { range: { type: 'enum', values: RANGES } } },
  needs_attention: { sizes: ['third', 'medium', 'large'] },
  insights: { sizes: ['large', 'full'] },
  balance: { sizes: ['large', 'full'] },
  setup_guide: { sizes: WIDE },
  recent_activity: { sizes: ['third', 'medium', 'large'], settings: { limit: LIMIT } },
  recent_orders: { sizes: ['third', 'medium', 'large'], settings: { limit: LIMIT } },
  traffic_sources: { sizes: ['third', 'medium', 'large'], settings: { range: { type: 'enum', values: RANGES } } },
  top_products: { sizes: ['third', 'medium', 'large'], settings: { limit: LIMIT } },
};

/** Widgets for the Super Admin Home. Keep ids in sync with solvexo-web `features/admin/pages/adminDashboardWidgets.tsx`. */
export const ADMIN_WIDGETS: Record<string, WidgetSpec> = {
  'kpi.total_stores': { sizes: SMALL_MEDIUM },
  'kpi.active_stores': { sizes: SMALL_MEDIUM },
  'kpi.mrr': { sizes: SMALL_MEDIUM },
  'kpi.critical_alerts': { sizes: SMALL_MEDIUM },
  'kpi.total_sellers': { sizes: SMALL_MEDIUM },
  'kpi.active_sellers': { sizes: SMALL_MEDIUM },
  'kpi.paid_subscribers': { sizes: SMALL_MEDIUM },
  'kpi.churn': { sizes: SMALL_MEDIUM },
  'kpi.plan_arr': { sizes: SMALL_MEDIUM },
  'kpi.gmv': { sizes: SMALL_MEDIUM },
  'kpi.new_users': { sizes: SMALL_MEDIUM },
  merchant_growth: { sizes: WIDE, settings: { range: { type: 'enum', values: RANGES } } },
  platform_revenue: { sizes: ['third', 'medium', 'large'], settings: { range: { type: 'enum', values: RANGES } } },
  plan_distribution: { sizes: ['third', 'medium', 'large'] },
  platform_alerts: { sizes: ['third', 'medium', 'large', 'full'] },
  system_health: { sizes: ['third', 'medium', 'large'] },
  recent_activity: { sizes: ['third', 'medium', 'large'], settings: { limit: LIMIT } },
  top_categories: { sizes: ['third', 'medium', 'large'] },
  growth_forecast: { sizes: ['large', 'full'] },
  quick_links: { sizes: ['small', 'third', 'medium'] },
};

export const MAX_WIDGETS = 40;

export interface LayoutWidget { id: string; visible: boolean; size: WidgetSize; settings: Record<string, string | number> }
export interface StoredLayout { preset: string | null; columns: 2 | 3; widgets: LayoutWidget[] }

const registry = (scope: DashboardScope) => (scope === 'store' ? STORE_WIDGETS : ADMIN_WIDGETS);
const bad = (msg: string): never => { throw new BadRequestException(msg); };

/** Strict validation of a client-supplied layout: only registry widgets, each at most once, an allowed size, and only the
 *  settings that widget declares with an allowed value. Never trusts anything else in the body. */
export function validateLayout(scope: DashboardScope, input: any): StoredLayout {
  const reg = registry(scope);
  const widgets = input?.widgets;
  if (!Array.isArray(widgets)) bad('widgets must be an array');
  if (widgets.length > MAX_WIDGETS) bad(`A dashboard can hold at most ${MAX_WIDGETS} widgets`);
  const seen = new Set<string>();
  const out: LayoutWidget[] = [];
  for (const w of widgets) {
    const id = typeof w?.id === 'string' ? w.id : '';
    const spec = Object.prototype.hasOwnProperty.call(reg, id) ? reg[id] : undefined;
    if (!spec) bad(`Unknown widget "${id}"`);
    if (seen.has(id)) bad(`Widget "${id}" is listed twice`);
    seen.add(id);
    const size = w.size as WidgetSize;
    if (!spec!.sizes.includes(size)) bad(`Widget "${id}" cannot be "${String(w.size)}"`);
    if (typeof w.visible !== 'boolean') bad(`Widget "${id}" needs visible true/false`);
    const settings: Record<string, string | number> = {};
    const given = w.settings && typeof w.settings === 'object' && !Array.isArray(w.settings) ? w.settings : {};
    for (const [key, value] of Object.entries(given)) {
      const rule = spec!.settings?.[key];
      if (!rule) bad(`Widget "${id}" has no setting "${key}"`);
      if (rule!.type === 'enum') {
        if (typeof value !== 'string' || !rule!.values.includes(value)) bad(`Invalid value for "${id}.${key}"`);
      } else if (!Number.isInteger(value) || (value as number) < rule!.min || (value as number) > rule!.max) {
        bad(`Invalid value for "${id}.${key}"`);
      }
      settings[key] = value as string | number;
    }
    out.push({ id, visible: w.visible, size, settings });
  }
  const columns = input.columns === undefined || input.columns === null ? 3 : input.columns;
  if (columns !== 2 && columns !== 3) bad('columns must be 2 or 3');
  const preset = typeof input.preset === 'string' && /^[a-z_]{1,30}$/.test(input.preset) ? input.preset : null;
  return { preset, columns, widgets: out };
}

/** A saved layout may still hold a widget a later release removed: drop it on read instead of failing the page. */
export function pruneLayout(scope: DashboardScope, layout: StoredLayout): StoredLayout {
  const reg = registry(scope);
  return { ...layout, widgets: (layout.widgets ?? []).filter((w) => Object.prototype.hasOwnProperty.call(reg, w.id) && reg[w.id].sizes.includes(w.size)) };
}
