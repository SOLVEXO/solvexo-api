import { ProductType, SellerType } from './schemas/store.schema';
import { buildSellerPersonalization, defaultProductTypesFor, CAPABILITIES, SELLER_PROFILES } from './seller-personalization';

const none = { physicalProducts: 0, digitalProducts: 0, suppliers: 0 };

describe('seller personalization', () => {
  it('every seller type has a profile (no type is decorative)', () => {
    for (const t of Object.values(SellerType)) expect(SELLER_PROFILES[t]).toBeDefined();
  });

  it('creator is guided to a first digital product and digital themes', () => {
    const r = buildSellerPersonalization({ sellerType: SellerType.CREATOR, productTypes: [ProductType.DIGITAL_DOWNLOADS] }, none);
    expect(r.focusTasks.map(t => t.id)).toEqual(['first_product_digital']);
    expect(r.themeCategories).toContain('digital_products');
  });

  it('educator is guided to courses first', () => {
    const r = buildSellerPersonalization({ sellerType: SellerType.EDUCATOR, productTypes: [ProductType.EDUCATIONAL_RESOURCES] }, none);
    expect(r.focusTasks[0].id).toBe('first_course');
    expect(r.themeCategories[0]).toBe('education');
  });

  it('retailer gets physical + shipping; brand also gets the POS app suggestion', () => {
    const retailer = buildSellerPersonalization({ sellerType: SellerType.RETAILER, productTypes: [ProductType.PHYSICAL_PRODUCTS] }, none);
    expect(retailer.focusTasks.map(t => t.id)).toEqual(['first_product_physical', 'shipping']);
    expect(retailer.recommendedApps).toEqual([]);
    const brand = buildSellerPersonalization({ sellerType: SellerType.BRAND_BUSINESS, productTypes: [] }, none);
    expect(brand.recommendedApps).toEqual([{ id: 'pos', reason: 'seller_type' }]);
  });

  it('reseller is pointed at suppliers (restocking), never at dropshipping', () => {
    const r = buildSellerPersonalization({ sellerType: SellerType.FREELANCER, productTypes: [] }, none);
    expect(r.focusTasks[0].id).toBe('first_supplier');
    expect(CAPABILITIES.find(c => c.id === 'dropshipping')?.status).toBe('coming_soon');
  });

  it('task completion comes from real counts only', () => {
    const r = buildSellerPersonalization(
      { sellerType: SellerType.RETAILER, productTypes: [ProductType.PHYSICAL_PRODUCTS] },
      { physicalProducts: 3, digitalProducts: 0, suppliers: 0 },
    );
    expect(r.focusTasks.find(t => t.id === 'first_product_physical')?.done).toBe(true);
    expect(r.focusTasks.find(t => t.id === 'shipping')?.done).toBeNull();
  });

  it('selling categories add guidance independent of seller type, and POS stays a separate app', () => {
    const r = buildSellerPersonalization(
      { sellerType: SellerType.CREATOR, productTypes: [ProductType.DIGITAL_DOWNLOADS, ProductType.PHYSICAL_PRODUCTS, ProductType.IN_PERSON_POS] },
      none,
    );
    expect(r.focusTasks.map(t => t.id)).toEqual(expect.arrayContaining(['first_product_digital', 'first_product_physical', 'shipping']));
    expect(r.recommendedApps).toEqual([{ id: 'pos', reason: 'product_type' }]);
    expect(CAPABILITIES.find(c => c.id === 'pos')?.status).toBe('separate_app');
  });

  it('legacy stores with missing values still work', () => {
    const r = buildSellerPersonalization({ sellerType: undefined, productTypes: undefined, enabledTools: undefined }, none);
    expect(r.sellerType).toBeNull();
    expect(r.productTypes).toEqual([]);
    expect(r.themeCategories).toEqual(['general']);
    const bogus = buildSellerPersonalization({ sellerType: 'individual' as unknown as SellerType, productTypes: null }, none);
    expect(bogus.sellerType).toBeNull();
  });

  it('seller-type defaults pre-tick the matching category (mix pre-ticks nothing)', () => {
    expect(defaultProductTypesFor(SellerType.CREATOR)).toEqual([ProductType.DIGITAL_DOWNLOADS]);
    expect(defaultProductTypesFor(SellerType.EDUCATOR)).toEqual([ProductType.EDUCATIONAL_RESOURCES]);
    expect(defaultProductTypesFor(SellerType.MIX)).toEqual([]);
    expect(defaultProductTypesFor(null)).toEqual([]);
  });
});
