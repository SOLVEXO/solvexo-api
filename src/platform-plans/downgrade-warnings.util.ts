import type { PlatformPlanLimits } from './entitlements.service';

/**
 * What a seller is told BEFORE switching to a cheaper plan: where the store is already over the new plan's numbers, and which
 * features of the current plan the new one does not have. Nothing is ever deleted or switched off by the plan change itself;
 * this is only a heads-up. Pure, so it can be tested without a database.
 */
export interface DowngradeUsage {
  products: number;
  staff: number;
  locations: number;
  /** Currencies the seller picked for checkout, or null when no specific list was chosen. */
  currencies: number | null;
  /** Marketing emails sent this month (campaigns, automations, abandoned-cart reminders). */
  emailsThisMonth: number;
  wholesaleCatalogs: number;
}

export interface UsageWarning { label: string; used: number; newLimit: number }

export const FEATURE_LABELS: Array<{ key: keyof PlatformPlanLimits; label: string }> = [
  { key: 'customDomainAllowed', label: 'Custom domain' },
  { key: 'whiteLabelAllowed', label: 'White-label branding' },
  { key: 'loyaltyProgramAllowed', label: 'Loyalty & rewards program' },
  { key: 'abandonedCartRecoveryAllowed', label: 'Abandoned cart recovery' },
  { key: 'emailCampaignsAllowed', label: 'Email marketing' },
  { key: 'digitalMembershipsAllowed', label: 'Memberships & access plans' },
  { key: 'digitalLicensesAllowed', label: 'License keys' },
  { key: 'digitalCoursesAllowed', label: 'Courses' },
  { key: 'b2bWholesaleAllowed', label: 'Wholesale (B2B)' },
  { key: 'apiWebhooksAllowed', label: 'API access & webhooks' },
  { key: 'advancedSeoToolsAllowed', label: 'SEO tools' },
  { key: 'seoAiSuggestionsAllowed', label: 'AI SEO suggestions' },
  { key: 'searchConsoleIntegrationAllowed', label: 'Google Search Console connection' },
  { key: 'customRedirectsAllowed', label: 'Custom redirects' },
  { key: 'calculatedShippingRatesAllowed', label: 'Live courier rates at checkout' },
  { key: 'prioritySupport', label: 'Priority support' },
  { key: 'dedicatedAccountManager', label: 'Your own account manager' },
];

export function buildDowngradeWarnings(
  usage: DowngradeUsage,
  currentLimits: Partial<PlatformPlanLimits>,
  newLimits: Partial<PlatformPlanLimits>,
): { usageWarnings: UsageWarning[]; lostFeatures: string[] } {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const checks: Array<{ label: string; used: number; limit: number | undefined }> = [
    { label: 'Products', used: usage.products, limit: num(newLimits.maxProducts) },
    { label: 'Staff accounts', used: usage.staff, limit: num(newLimits.maxStaffAccounts) },
    { label: 'POS locations', used: usage.locations, limit: num(newLimits.maxPosLocations) },
    { label: 'Marketing emails this month', used: usage.emailsThisMonth, limit: num(newLimits.monthlyEmailSends) },
    { label: 'Wholesale catalogs', used: usage.wholesaleCatalogs, limit: num(newLimits.maxB2BCatalogs) },
  ];
  // Markets: only when the seller picked a specific list (buyers otherwise keep the store currency + the first extras that fit).
  if (usage.currencies !== null && usage.currencies > 0) {
    checks.push({ label: 'Checkout currencies (markets)', used: usage.currencies, limit: num(newLimits.maxMarkets) });
  }
  const usageWarnings = checks
    .filter((c): c is { label: string; used: number; limit: number } => c.limit !== undefined && c.limit !== -1 && c.used > c.limit)
    .map((c) => ({ label: c.label, used: c.used, newLimit: c.limit }));

  const lostFeatures = FEATURE_LABELS
    .filter((f) => !!currentLimits[f.key] && !newLimits[f.key])
    .map((f) => f.label);

  return { usageWarnings, lostFeatures };
}
