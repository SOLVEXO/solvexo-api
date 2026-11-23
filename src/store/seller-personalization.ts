import { ProductType, SellerType, StoreTool } from './schemas/store.schema';

/**
 * Seller personalization — ONE place that turns "who the seller is" (sellerType) and "what they sell" (productTypes)
 * into setup guidance. It never restricts anything: every product type stays creatable whatever the seller chose,
 * and nothing here hides a feature. It only orders, suggests and explains.
 *
 * Everything it can recommend is backed by something that exists today (see CAPABILITIES). Features that are not
 * built are reported honestly as `coming_soon` so no screen has to claim them.
 */

export type SetupFocusTaskId =
  | 'first_product_physical'
  | 'first_product_digital'
  | 'first_course'
  | 'first_supplier'
  | 'shipping'
  | 'verify'
  | 'domain';

export type RecommendedAppId = 'pos';

export type CapabilityId = 'physical_products' | 'digital_downloads' | 'courses' | 'suppliers' | 'pos' | 'services_bookings' | 'dropshipping';
export type CapabilityStatus = 'available' | 'separate_app' | 'coming_soon';

export interface Capability {
  id: CapabilityId;
  status: CapabilityStatus;
}

/** What is really shipped. Update here when a feature lands — the onboarding copy and dashboard read this. */
export const CAPABILITIES: Capability[] = [
  { id: 'physical_products', status: 'available' },
  { id: 'digital_downloads', status: 'available' },
  { id: 'courses', status: 'available' },
  { id: 'suppliers', status: 'available' }, // supplier + purchase-order restocking only, not supplier-to-customer fulfilment
  { id: 'pos', status: 'separate_app' }, // the Solvexo POS Android app, never part of the core store
  { id: 'services_bookings', status: 'coming_soon' },
  { id: 'dropshipping', status: 'coming_soon' },
];

interface SellerProfile {
  /** Pre-ticked in "What you sell"; the seller can change every one of them. */
  defaultProductTypes: ProductType[];
  /** Setup tasks to surface first, in order. */
  focusTasks: SetupFocusTaskId[];
  /** Theme-catalog categories that suit this seller (real catalog ids; the catalog decides which themes exist). */
  themeCategories: string[];
  recommendedApps: RecommendedAppId[];
}

export const SELLER_PROFILES: Record<SellerType, SellerProfile> = {
  [SellerType.CREATOR]: {
    defaultProductTypes: [ProductType.DIGITAL_DOWNLOADS],
    focusTasks: ['first_product_digital'],
    themeCategories: ['digital_products', 'general'],
    recommendedApps: [],
  },
  [SellerType.EDUCATOR]: {
    defaultProductTypes: [ProductType.EDUCATIONAL_RESOURCES],
    focusTasks: ['first_course', 'first_product_digital'],
    themeCategories: ['education', 'digital_products', 'general'],
    recommendedApps: [],
  },
  [SellerType.RETAILER]: {
    defaultProductTypes: [ProductType.PHYSICAL_PRODUCTS],
    focusTasks: ['first_product_physical', 'shipping'],
    themeCategories: ['fashion', 'beauty', 'electronics', 'jewelry', 'furniture', 'food', 'general'],
    recommendedApps: [],
  },
  [SellerType.BRAND_BUSINESS]: {
    defaultProductTypes: [ProductType.PHYSICAL_PRODUCTS],
    focusTasks: ['first_product_physical', 'shipping', 'verify', 'domain'],
    themeCategories: ['general', 'fashion', 'electronics', 'furniture', 'beauty'],
    recommendedApps: ['pos'],
  },
  [SellerType.FREELANCER]: {
    defaultProductTypes: [ProductType.PHYSICAL_PRODUCTS],
    focusTasks: ['first_supplier', 'first_product_physical', 'shipping'],
    themeCategories: ['general', 'electronics', 'fashion'],
    recommendedApps: [],
  },
  [SellerType.MIX]: {
    defaultProductTypes: [],
    focusTasks: [],
    themeCategories: ['general'],
    recommendedApps: [],
  },
};

/** What each "What you sell" choice adds on top of the seller type. */
const PRODUCT_TYPE_EFFECTS: Partial<Record<ProductType, { tasks: SetupFocusTaskId[]; themeCategories: string[]; apps: RecommendedAppId[] }>> = {
  [ProductType.PHYSICAL_PRODUCTS]: { tasks: ['first_product_physical', 'shipping'], themeCategories: ['general'], apps: [] },
  [ProductType.DIGITAL_DOWNLOADS]: { tasks: ['first_product_digital'], themeCategories: ['digital_products'], apps: [] },
  [ProductType.EDUCATIONAL_RESOURCES]: { tasks: ['first_course', 'first_product_digital'], themeCategories: ['education', 'digital_products'], apps: [] },
  [ProductType.IN_PERSON_POS]: { tasks: [], themeCategories: [], apps: ['pos'] },
};

/** Default "What you sell" ticks for a seller type (Step 4 pre-selection). */
export function defaultProductTypesFor(sellerType: SellerType | null | undefined): ProductType[] {
  return sellerType && SELLER_PROFILES[sellerType] ? [...SELLER_PROFILES[sellerType].defaultProductTypes] : [];
}

/** Real counts read from the store's own data — the only input that decides whether a task is done. */
export interface PersonalizationFacts {
  physicalProducts: number;
  digitalProducts: number; // digital + educational products
  suppliers: number;
}

export interface SellerPersonalization {
  sellerType: SellerType | null;
  productTypes: ProductType[];
  enabledTools: StoreTool[];
  /** Tasks the Setup Guide should bring forward, with their real completion (`first_course` is decided by the
   *  courses API, so it is reported with `done: null`). */
  focusTasks: { id: SetupFocusTaskId; done: boolean | null }[];
  themeCategories: string[];
  recommendedApps: { id: RecommendedAppId; reason: 'seller_type' | 'product_type' }[];
  capabilities: Capability[];
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

export function buildSellerPersonalization(
  store: { sellerType?: SellerType | null; productTypes?: ProductType[] | null; enabledTools?: StoreTool[] | null },
  facts: PersonalizationFacts,
): SellerPersonalization {
  // Legacy stores can have a missing sellerType / productTypes: they keep working, guidance just falls back to a neutral profile.
  const sellerType = store.sellerType && SELLER_PROFILES[store.sellerType] ? store.sellerType : null;
  const productTypes = Array.isArray(store.productTypes) ? store.productTypes : [];
  const profile = sellerType ? SELLER_PROFILES[sellerType] : SELLER_PROFILES[SellerType.MIX];

  const taskIds = unique<SetupFocusTaskId>([
    ...profile.focusTasks,
    ...productTypes.flatMap(t => PRODUCT_TYPE_EFFECTS[t]?.tasks ?? []),
  ]);
  const done = (id: SetupFocusTaskId): boolean | null => {
    if (id === 'first_product_physical') return facts.physicalProducts > 0;
    if (id === 'first_product_digital') return facts.digitalProducts > 0;
    if (id === 'first_supplier') return facts.suppliers > 0;
    return null; // first_course / shipping / verify / domain already have a real signal in the dashboard itself
  };

  const apps: SellerPersonalization['recommendedApps'] = [
    ...profile.recommendedApps.map(id => ({ id, reason: 'seller_type' as const })),
    ...productTypes.flatMap(t => (PRODUCT_TYPE_EFFECTS[t]?.apps ?? []).map(id => ({ id, reason: 'product_type' as const }))),
  ].filter((a, i, all) => all.findIndex(x => x.id === a.id) === i);

  return {
    sellerType,
    productTypes,
    enabledTools: Array.isArray(store.enabledTools) ? store.enabledTools : [],
    focusTasks: taskIds.map(id => ({ id, done: done(id) })),
    themeCategories: unique([...profile.themeCategories, ...productTypes.flatMap(t => PRODUCT_TYPE_EFFECTS[t]?.themeCategories ?? [])]),
    recommendedApps: apps,
    capabilities: CAPABILITIES,
  };
}
