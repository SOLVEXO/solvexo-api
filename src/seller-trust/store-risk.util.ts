/* eslint-disable prettier/prettier */
// Pure store risk assessment — admin-only signal, never shown to the seller.
// Level = the highest severity among the reasons ('info' never raises it).

export type RiskLevel = 'low' | 'medium' | 'high';
export type RiskSeverity = 'info' | 'medium' | 'high';
export interface RiskReason { code: string; label: string; severity: RiskSeverity }

export interface StoreRiskInput {
  verificationStatus?: string | null;
  /** True once the store's verification deadline has passed (and it isn't verified). */
  deadlinePassed?: boolean;
  country?: string | null;
  hasNtn?: boolean;
  businessProfile?: {
    sourcing?: string | null;
    sellsBrandedGoods?: boolean | null;
    regulatedCategories?: string[] | null;
    returnPolicy?: string | null;
    bankAccountInOwnName?: boolean | null;
  } | null;
  /** Types of the documents the seller has uploaded. */
  documentTypes?: string[];
  createdAt?: Date | string | null;
  now?: Date;
  /** Seller-order stats for this store. */
  orders30d?: number;
  refunds30d?: number;
  avgOrderValue30d?: number;
  orders7d?: number;
  avgOrderValue7d?: number;
  /** Open (not resolved) buyer reports against the store / its listings. */
  openReports?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RANK: Record<RiskSeverity, number> = { info: 0, medium: 1, high: 2 };

export function computeStoreRisk(input: StoreRiskInput): { level: RiskLevel; reasons: RiskReason[] } {
  const now = input.now ?? new Date();
  const reasons: RiskReason[] = [];
  const profile = input.businessProfile ?? {};
  const docs = new Set(input.documentTypes ?? []);
  const country = (input.country ?? 'PK').toUpperCase();

  if (input.verificationStatus !== 'verified') {
    reasons.push(input.deadlinePassed
      ? { code: 'not_verified_overdue', label: 'Not verified and the verification deadline has passed', severity: 'high' }
      : { code: 'not_verified', label: 'Business not verified yet', severity: 'medium' });
  }
  if (country === 'PK' && !input.hasNtn) {
    reasons.push({ code: 'missing_ntn', label: 'No NTN on file', severity: 'medium' });
  }
  if ((profile.regulatedCategories ?? []).length > 0 && !docs.has('product_licence')) {
    reasons.push({ code: 'regulated_without_licence', label: `Sells regulated products (${(profile.regulatedCategories ?? []).join(', ')}) without a product licence`, severity: 'high' });
  }
  if (profile.sellsBrandedGoods === true && !docs.has('brand_authorization')) {
    reasons.push({ code: 'branded_without_authorization', label: 'Sells branded goods without a brand authorization', severity: 'medium' });
  }
  if (profile.sourcing === 'dropshipper' && profile.returnPolicy === 'no_returns') {
    reasons.push({ code: 'dropship_no_returns', label: 'Dropshipper with no returns', severity: 'medium' });
  }
  if (profile.bankAccountInOwnName === false) {
    reasons.push({ code: 'bank_not_own_name', label: 'Bank account is not in the owner\'s name', severity: 'medium' });
  }
  if (input.createdAt && now.getTime() - new Date(input.createdAt).getTime() < 14 * DAY_MS) {
    reasons.push({ code: 'new_store', label: 'Store is less than 14 days old', severity: 'info' });
  }
  const orders30d = input.orders30d ?? 0;
  if (orders30d >= 10 && (input.refunds30d ?? 0) / orders30d >= 0.1) {
    reasons.push({ code: 'high_refund_rate', label: `High refund rate: ${input.refunds30d} of ${orders30d} orders in 30 days`, severity: 'high' });
  }
  if ((input.openReports ?? 0) >= 2) {
    reasons.push({ code: 'open_reports', label: `${input.openReports} open buyer reports`, severity: 'high' });
  }
  const avg30 = input.avgOrderValue30d ?? 0;
  if ((input.orders7d ?? 0) >= 5 && avg30 > 0 && (input.avgOrderValue7d ?? 0) > 3 * avg30) {
    reasons.push({ code: 'order_value_spike', label: 'Average order value in the last 7 days is over 3x the 30-day average', severity: 'medium' });
  }

  const top = reasons.reduce((max, r) => Math.max(max, RANK[r.severity]), 0);
  const level: RiskLevel = top === 2 ? 'high' : top === 1 ? 'medium' : 'low';
  return { level, reasons };
}
