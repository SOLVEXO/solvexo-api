/* eslint-disable prettier/prettier */
/**
 * Answer options of the field-visit form (Sales Ops → New visit). The keys are what the API stores and validates; the
 * labels are used in the lead timeline and the CSV. The web form keeps the same keys with English + Urdu labels
 * (`solvexo-web/src/features/admin/pages/sales/visits/visitOptions.ts`); change both together.
 */
export const VISIT_OPTIONS = {
  floor: { basement: 'Basement', ground: 'Ground', first: '1st', second: '2nd', third_plus: '3rd+' },
  category: {
    clothing: 'Clothing', shoes: 'Shoes', bags_accessories: 'Bags & accessories', jewellery: 'Jewellery', cosmetics: 'Cosmetics',
    electronics_mobiles: 'Electronics & mobiles', home_kitchen: 'Home & kitchen', kids_toys: 'Kids & toys', grocery: 'Grocery',
    pharmacy: 'Pharmacy', other: 'Other',
  },
  priceRange: { budget: 'Budget', mid: 'Mid', premium: 'Premium' },
  wholesale: { retail: 'Retail only', wholesale: 'Wholesale only', both: 'Both' },
  contactRole: { owner: 'Owner', partner: 'Partner', manager: 'Manager', staff: 'Staff' },
  bestTime: { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', after_closing: 'After closing' },
  sellsOn: { shop: 'Shop', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', daraz: 'Daraz', website: 'Website' },
  ordersPerMonth: { none: '0', '1_20': '1–20', '21_100': '21–100', '101_500': '101–500', '500_plus': '500+' },
  payments: { cod: 'COD', easypaisa: 'Easypaisa', jazzcash: 'JazzCash', bank: 'Bank transfer', card: 'Card' },
  couriers: {
    tcs: 'TCS', leopards: 'Leopards', mnp: 'M&P', postex: 'PostEx', trax: 'Trax', blueex: 'BlueEx', call_courier: 'Call Courier',
    own_rider: 'Own rider', none: 'None',
  },
  courierBooking: { portal: 'Courier portal', phone: 'Phone call', rider_pickup: 'Rider pickup', app: 'App' },
  billing: { manual: 'Manual register', excel: 'Excel', software: 'Software', none: 'None' },
  khata: { no: 'No', paper: 'Yes · paper', app: 'Yes · app' },
  seasons: {
    eid_fitr: 'Eid ul-Fitr', eid_adha: 'Eid ul-Adha', ramadan: 'Ramadan', wedding: 'Wedding season', winter: 'Winter',
    summer: 'Summer', back_to_school: 'Back to school', sale_events: '11.11 / Black Friday',
  },
  problemTags: {
    low_sales: 'Low sales', stock_tracking: 'Stock tracking', cod_returns: 'COD returns', no_time_online: 'No time online',
    courier_issues: 'Courier issues',
  },
  objections: {
    too_expensive: 'Too expensive', has_system: 'Already have a system', not_tech_savvy: 'Not tech-savvy', no_time: 'No time',
    ask_partner: 'Need to ask partner', trust: 'Trust / security', think_about_it: 'Will think about it',
  },
  interest: { hot: 'Hot', warm: 'Warm', cold: 'Cold', not_interested: 'Not interested' },
  nextStep: {
    demo: 'Demo', send_price: 'Send price on WhatsApp', revisit: 'Revisit', signup: 'Sign-up', call_back: 'Call back', none: 'None',
  },
} as const;

export type VisitOptionGroup = keyof typeof VISIT_OPTIONS;
export const optionKeys = <G extends VisitOptionGroup>(g: G) => Object.keys(VISIT_OPTIONS[g]) as (keyof (typeof VISIT_OPTIONS)[G] & string)[];
export const optionLabel = (g: VisitOptionGroup, key: string | null | undefined): string =>
  key ? ((VISIT_OPTIONS[g] as Record<string, string>)[key] ?? key) : '';

/** Lead tags that carry the latest visit's interest, so the pipeline can be filtered by it. */
export const INTEREST_TAGS = ['hot', 'warm', 'cold', 'not interested'] as const;

/** Largest shop photo accepted, after the phone has shrunk it (the whole JSON request is capped at 1 MB). */
export const VISIT_PHOTO_MAX_BYTES = 700 * 1024;
