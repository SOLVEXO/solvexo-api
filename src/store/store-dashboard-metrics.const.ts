/**
 * Single source of truth for the Store Dashboard's "Customize" picker —
 * mirrors Shopify's real Home-page metrics customization (add/remove/
 * reorder cards from a fixed library — see help.shopify.com's "Customizing
 * the Analytics overview dashboard"). Every id here must have a matching,
 * real backend-computed value already available to `StoreDashboard.tsx`
 * (from `SellerOverviewData`/`SellerTodaySummaryData`/the inventory stats
 * call it already makes) — never a metric invented just to fill the list.
 *
 * `DEFAULT_DASHBOARD_METRICS` is what every pre-existing store (whose
 * `Store.dashboardMetrics` is still null) has always shown — changing this
 * array's DEFAULT set would silently change existing sellers' dashboards,
 * so it must only ever grow by adding new non-default entries, never by
 * reordering/removing the existing 4.
 */
export interface DashboardMetricDefinition {
  id: string;
  label: string;
}

export const DASHBOARD_METRIC_CATALOG: DashboardMetricDefinition[] = [
  { id: 'revenue_30d', label: 'Revenue (30 days)' },
  { id: 'orders_30d', label: 'Orders (30 days)' },
  { id: 'active_products', label: 'Active Products' },
  { id: 'customers_30d', label: 'Customers (30 days)' },
  { id: 'avg_order_value_30d', label: 'Average Order Value (30 days)' },
  { id: 'refund_rate_30d', label: 'Refund Rate (30 days)' },
  { id: 'repeat_buyer_rate_30d', label: 'Repeat Buyer Rate (30 days)' },
  { id: 'today_revenue', label: "Today's Revenue" },
  { id: 'today_orders', label: "Today's Orders" },
  { id: 'today_avg_order_value', label: "Today's Average Order Value" },
];

export const DASHBOARD_METRIC_IDS: string[] = DASHBOARD_METRIC_CATALOG.map((m) => m.id);

export const DEFAULT_DASHBOARD_METRICS: string[] = ['revenue_30d', 'orders_30d', 'active_products', 'customers_30d'];
