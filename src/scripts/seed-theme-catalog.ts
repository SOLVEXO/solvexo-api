/**
 * One-time (safely re-runnable) seed for the full 44-theme Theme Marketplace
 * catalog — 4 themes across each of the 11 categories (fashion, beauty,
 * electronics, jewelry, furniture, food, restaurant, education, digital
 * products, services, general). The first 10 (Horizon/Vogue/Essential/
 * Atelier/Nova/Royale/Freshly/Urban/Aura/Volt) migrate the original curated
 * presets that used to live only in the frontend's `builder/themes.ts`,
 * re-slotted into their matching official name/category (e.g. the old
 * "modern-fashion" preset becomes "Vogue" in `fashion`); the remaining 34
 * are authored fresh using the same engine. Every theme gets a real,
 * structurally distinct `homePageSections` composition (not just a
 * recolor) — different section choice, order, and copy per theme, using
 * the full section-type toolkit (hero, product catalog, testimonials,
 * feature lists, spec tables, menus, team grids, location info, stats,
 * galleries, trust badges, newsletter).
 *
 * Upserts by `slug`, so running this twice never creates duplicates and is
 * safe to re-run after tweaking content below.
 *
 * Usage: npx ts-node src/scripts/seed-theme-catalog.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

function img(id: number, w = 1600, h = 900) {
  return `https://picsum.photos/id/${id}/${w}/${h}`;
}

// ── Section-builder shorthands — mirror `common/schemas/section.schema.ts` /
// `block.schema.ts` shapes exactly (validated identically on save by
// `ThemeCatalogService`, so any mistake here surfaces immediately). ────────
function hero(
  heading: string,
  subheading: string,
  ctaText: string,
  imgId: number,
  heightPreset: 'small' | 'medium' | 'large' = 'large',
) {
  return {
    type: 'hero',
    enabled: true,
    settings: { heightPreset },
    blocks: [
      {
        type: 'hero_slide',
        enabled: true,
        settings: {
          imageUrl: img(imgId),
          heading,
          subheading,
          ctaText,
          ctaLink: { linkType: 'home' },
        },
      },
    ],
  };
}
function productCatalog(heading: string) {
  return {
    type: 'product_catalog',
    enabled: true,
    settings: { heading, defaultSort: 'newest', columns: 3, showFilters: true },
    blocks: [],
  };
}
function testimonials(
  quote: string,
  authorName: string,
  authorRole: string,
  rating = 5,
) {
  return {
    type: 'testimonials',
    enabled: true,
    settings: { heading: 'What customers say' },
    blocks: [
      {
        type: 'testimonial',
        enabled: true,
        settings: { quote, authorName, authorRole, rating },
      },
    ],
  };
}
function newsletter() {
  return {
    type: 'newsletter',
    enabled: true,
    settings: {
      heading: 'Stay in the loop',
      subtext: 'New arrivals and offers, straight to your inbox.',
    },
    blocks: [],
  };
}
function trustBadges() {
  return {
    type: 'trust_badges',
    enabled: true,
    settings: {},
    blocks: [
      {
        type: 'trust_badge_item',
        enabled: true,
        settings: { icon: 'truck', text: 'Fast Shipping' },
      },
      {
        type: 'trust_badge_item',
        enabled: true,
        settings: { icon: 'refresh', text: 'Easy Returns' },
      },
      {
        type: 'trust_badge_item',
        enabled: true,
        settings: { icon: 'lock', text: 'Secure Payment' },
      },
    ],
  };
}
function featureList(
  heading: string,
  items: { icon: string; title: string; description: string }[],
) {
  return {
    type: 'feature_list',
    enabled: true,
    settings: { heading },
    blocks: items.map((i) => ({
      type: 'feature_item',
      enabled: true,
      settings: i,
    })),
  };
}
function galleryGrid(heading: string, imgIds: number[]) {
  return {
    type: 'gallery_grid',
    enabled: true,
    settings: { heading },
    blocks: imgIds.map((id) => ({
      type: 'gallery_image',
      enabled: true,
      settings: { imageUrl: img(id, 900, 1100) },
    })),
  };
}
function statsCounter(stats: { value: string; label: string }[]) {
  return {
    type: 'stats_counter',
    enabled: true,
    settings: {},
    blocks: stats.map((s) => ({
      type: 'stat_item',
      enabled: true,
      settings: s,
    })),
  };
}
function specTable(heading: string, rows: { label: string; value: string }[]) {
  return {
    type: 'spec_table',
    enabled: true,
    settings: { heading },
    blocks: rows.map((r) => ({ type: 'spec_row', enabled: true, settings: r })),
  };
}
function menuList(
  heading: string,
  subheading: string,
  items: {
    name: string;
    description: string;
    price: number;
    category?: string;
  }[],
) {
  return {
    type: 'menu_list',
    enabled: true,
    settings: { heading, subheading },
    blocks: items.map((i) => ({
      type: 'menu_item',
      enabled: true,
      settings: i,
    })),
  };
}
function teamGrid(
  heading: string,
  members: { name: string; role: string; bio?: string }[],
) {
  return {
    type: 'team_grid',
    enabled: true,
    settings: { heading },
    blocks: members.map((m) => ({
      type: 'team_member',
      enabled: true,
      settings: m,
    })),
  };
}
function locationInfo(heading: string, address: string, hours: string) {
  return {
    type: 'location_info',
    enabled: true,
    settings: { heading, address, hours },
  };
}

function colors(overrides: Record<string, any>) {
  return {
    primaryColor: '#D97757',
    accentColor: '#B95A3A',
    bgColor: '#FAF9F5',
    textColor: '#2C2A28',
    font: 'Poppins',
    buttonStyle: 'solid',
    buttonRadius: 'medium',
    buttonWidth: 'auto',
    buttonSize: 'md',
    imageRadius: 'medium',
    typeScale: 'comfortable',
    containerWidth: 'standard',
    sectionSpacing: 'comfortable',
    productCardStyle: 'outlined',
    productCardRadius: 'medium',
    testimonialCardStyle: 'outlined',
    testimonialCardRadius: 'medium',
    heroStyle: 'overlay',
    heroAlignment: 'left',
    productImageRatio: 'square',
    productImageHover: 'none',
    productGridDensity: 'cozy',
    testimonialStyle: 'cards',
    faqStyle: 'accordion',
    ...overrides,
  };
}
function header(headerStyle: 'standard' | 'centered') {
  return {
    logoSource: 'store',
    customLogoUrl: null,
    blocks: [],
    navAlignment: 'left',
    headerStyle,
  };
}
function footer(footerStyle: 'columns' | 'minimal') {
  return { blocks: [], footerStyle };
}
const IDENTITY_BANNER_DEFAULT = {
  showFollowButton: true,
  showMessageButton: true,
  showLoyaltyButton: true,
  showMembershipButton: true,
  layout: 'standard',
  showBadges: true,
  showFollowerCount: true,
  showProductCount: true,
  showRating: true,
  descriptionMaxLines: null,
};

const THEMES = [
  {
    slug: 'horizon',
    name: 'Horizon',
    category: 'general',
    tags: ['universal', 'warm', 'handmade'],
    description:
      'Universal commerce — warm terracotta, a full-bleed hero, and soft rounded cards. The safe, versatile baseline every store starts equivalent to.',
    theme: colors({}),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Handcrafted, with intention.',
        'Small-batch goods, made slowly.',
        'Shop the Collection',
        10,
      ),
      featureList('Why shop with us', [
        {
          icon: 'leaf',
          title: 'Sustainably Made',
          description: 'Small-batch production, minimal waste.',
        },
        {
          icon: 'heart',
          title: 'Made With Care',
          description: 'Every piece checked by hand before it ships.',
        },
        {
          icon: 'star',
          title: 'Loved by Buyers',
          description: 'Consistently rated 5 stars by real customers.',
        },
      ]),
      productCatalog('Our Products'),
      testimonials(
        'Every piece feels like it was made just for me.',
        'Priya N.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'vogue',
    name: 'Vogue',
    category: 'fashion',
    tags: ['luxury', 'editorial', 'fashion'],
    description:
      'Luxury editorial fashion — a dramatic split hero, editorial type, and a full-width CTA for a premium wardrobe edit.',
    theme: colors({
      primaryColor: '#1F1B2E',
      accentColor: '#C9A15A',
      bgColor: '#FFFFFF',
      textColor: '#1A1720',
      font: 'Montserrat',
      buttonRadius: 'small',
      buttonWidth: 'full',
      buttonSize: 'lg',
      imageRadius: 'small',
      containerWidth: 'wide',
      productCardStyle: 'elevated',
      productCardRadius: 'small',
      testimonialCardStyle: 'flat',
      testimonialCardRadius: 'none',
      heroStyle: 'split',
      productImageRatio: 'portrait',
      productImageHover: 'zoom',
      productGridDensity: 'relaxed',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'The Fall/Winter Edit.',
        'Tailored silhouettes for a modern wardrobe.',
        'Shop Now',
        50,
      ),
      galleryGrid('The Lookbook', [55, 56, 57]),
      productCatalog('Shop the Edit'),
      testimonials(
        'The quality and fit are unmatched. Worth every dollar.',
        'Amara K.',
        'Verified Buyer',
      ),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'essential',
    name: 'Essential',
    category: 'general',
    tags: ['minimal', 'clean', 'universal'],
    description:
      'A clean universal store — restrained monochrome, sharp corners, and generous whitespace.',
    theme: colors({
      primaryColor: '#111111',
      accentColor: '#6E6E6E',
      bgColor: '#FFFFFF',
      textColor: '#111111',
      font: 'Inter',
      buttonStyle: 'outline',
      buttonRadius: 'none',
      buttonSize: 'sm',
      imageRadius: 'none',
      typeScale: 'compact',
      containerWidth: 'narrow',
      sectionSpacing: 'compact',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      testimonialCardStyle: 'flat',
      testimonialCardRadius: 'none',
      heroAlignment: 'center',
      testimonialStyle: 'minimal',
      faqStyle: 'list',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Less, but better.',
        'A tightly-edited collection of everyday essentials.',
        'Explore',
        90,
        'medium',
      ),
      productCatalog('Shop Everyday Essentials'),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'atelier',
    name: 'Atelier',
    category: 'fashion',
    tags: ['premium', 'editorial', 'minimalist'],
    description:
      'Premium minimalist fashion — magazine-inspired commerce with oversized serif headlines and a bordered product grid.',
    theme: colors({
      primaryColor: '#8A6D3B',
      accentColor: '#5F4A28',
      bgColor: '#FBFAF7',
      textColor: '#242220',
      font: 'Fraunces',
      buttonStyle: 'outline',
      buttonRadius: 'small',
      buttonSize: 'lg',
      imageRadius: 'large',
      typeScale: 'spacious',
      containerWidth: 'wide',
      sectionSpacing: 'spacious',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
      testimonialCardStyle: 'elevated',
      testimonialCardRadius: 'large',
      heroStyle: 'split',
      productImageRatio: 'portrait',
      productGridDensity: 'relaxed',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Issue No. 12 — The Edit.',
        'Stories in fabric. A seasonal capsule, curated.',
        'Read the Edit',
        130,
      ),
      galleryGrid('From the Atelier', [135, 136, 137]),
      productCatalog('The Capsule'),
      testimonials(
        'Feels less like shopping and more like reading a magazine.',
        'Jonas W.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'nova',
    name: 'Nova',
    category: 'general',
    tags: ['modern', 'vibrant', 'universal'],
    description:
      'A modern general store — contemporary ecommerce, vibrant and fully rounded, with soft-tinted buttons.',
    theme: colors({
      primaryColor: '#FF6B35',
      accentColor: '#FFB627',
      bgColor: '#FFFDF9',
      textColor: '#241C15',
      font: 'DM Sans',
      buttonStyle: 'soft',
      buttonRadius: 'full',
      imageRadius: 'full',
      productCardStyle: 'elevated',
      productCardRadius: 'full',
      testimonialCardStyle: 'flat',
      testimonialCardRadius: 'full',
      heroStyle: 'split',
      heroAlignment: 'center',
      productImageHover: 'zoom',
      productGridDensity: 'relaxed',
      testimonialStyle: 'minimal',
      faqStyle: 'list',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'New arrivals, every week.',
        'Everyday basics, done right.',
        'Shop New In',
        170,
        'medium',
      ),
      statsCounter([
        { value: '50k+', label: 'Happy Customers' },
        { value: '4.8★', label: 'Average Rating' },
        { value: '24h', label: 'Fast Dispatch' },
      ]),
      productCatalog('Our Products'),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'royale',
    name: 'Royale',
    category: 'jewelry',
    tags: ['luxury', 'dark', 'fine-jewelry'],
    description:
      'Luxury jewelry — a deep dark palette with cinematic imagery, crafted for a lifetime.',
    theme: colors({
      primaryColor: '#C9A461',
      accentColor: '#8B7333',
      bgColor: '#0E0D0C',
      textColor: '#F3F1EA',
      font: 'Playfair Display',
      buttonStyle: 'outline',
      buttonRadius: 'none',
      imageRadius: 'none',
      typeScale: 'spacious',
      containerWidth: 'wide',
      sectionSpacing: 'spacious',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      testimonialCardStyle: 'flat',
      testimonialCardRadius: 'none',
      heroAlignment: 'center',
      productImageRatio: 'portrait',
      productImageHover: 'zoom',
      productGridDensity: 'relaxed',
      testimonialStyle: 'minimal',
      faqStyle: 'list',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Timeless, by design.',
        'Fine jewelry crafted for a lifetime.',
        'Discover the Collection',
        210,
        'medium',
      ),
      featureList('Craftsmanship', [
        {
          icon: 'award',
          title: 'Ethically Sourced',
          description: 'Every stone and metal traced to its origin.',
        },
        {
          icon: 'shield',
          title: 'Lifetime Warranty',
          description: 'Repairs and resizing, free, for life.',
        },
        {
          icon: 'sparkles',
          title: 'Hand-Set Stones',
          description: 'Set by master jewelers, one piece at a time.',
        },
      ]),
      productCatalog('The Collection'),
      testimonials(
        'Exquisite craftsmanship — it photographs even better in person.',
        'Camille D.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'freshly',
    name: 'Freshly',
    category: 'food',
    tags: ['organic', 'grocery', 'fresh'],
    description:
      'Grocery & food — a natural palette with a friendly, rounded feel, from farm to table.',
    theme: colors({
      primaryColor: '#4C7A3D',
      accentColor: '#D98E2D',
      bgColor: '#FBF8F0',
      textColor: '#2B2A22',
      font: 'Nunito',
      buttonRadius: 'full',
      imageRadius: 'large',
      productCardStyle: 'outlined',
      productCardRadius: 'large',
      testimonialCardStyle: 'outlined',
      testimonialCardRadius: 'large',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'From farm to table.',
        'Organic, seasonal, delivered fresh.',
        'Shop Fresh',
        250,
      ),
      featureList('Why buyers choose us', [
        {
          icon: 'leaf',
          title: '100% Organic',
          description: 'Certified organic, every single item.',
        },
        {
          icon: 'droplet',
          title: 'Farm Fresh',
          description: 'Sourced and shipped within 48 hours of harvest.',
        },
        {
          icon: 'heart',
          title: 'Locally Grown',
          description: 'Supporting small, local farms.',
        },
      ]),
      productCatalog('Shop Fresh'),
      testimonials(
        'Everything tastes like it was picked this morning.',
        'Noah B.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'urban',
    name: 'Urban',
    category: 'fashion',
    tags: ['streetwear', 'bold', 'energetic'],
    description:
      'Modern streetwear — bold contrast type and an energetic, edge-to-edge grid for sneakers and streetwear drops.',
    theme: colors({
      primaryColor: '#E8382A',
      accentColor: '#1A1A1A',
      bgColor: '#F5F4F0',
      textColor: '#111111',
      font: 'Space Grotesk',
      buttonRadius: 'none',
      buttonWidth: 'full',
      buttonSize: 'lg',
      imageRadius: 'none',
      typeScale: 'spacious',
      containerWidth: 'wide',
      sectionSpacing: 'compact',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      testimonialCardStyle: 'flat',
      testimonialCardRadius: 'none',
      productImageHover: 'zoom',
      testimonialStyle: 'minimal',
      faqStyle: 'list',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Built for the street.',
        'New drop, limited run.',
        'Shop the Drop',
        290,
      ),
      statsCounter([
        { value: '120k+', label: 'Units Sold' },
        { value: '4.7★', label: 'Rated by Buyers' },
        { value: '15 min', label: 'Avg. Drop Sellout' },
      ]),
      productCatalog('Shop the Drop'),
      galleryGrid('On the Street', [295, 296, 297]),
      newsletter(),
    ],
  },
  {
    slug: 'aura',
    name: 'Aura',
    category: 'beauty',
    tags: ['skincare', 'clean', 'elegant'],
    description:
      'Elegant skincare — soft neutrals, spacious layout, and subtle shadow-only cards.',
    theme: colors({
      primaryColor: '#C98B7A',
      accentColor: '#E8B4A0',
      bgColor: '#FBF6F3',
      textColor: '#3A2E2A',
      font: 'Lora',
      buttonStyle: 'soft',
      buttonRadius: 'large',
      imageRadius: 'large',
      containerWidth: 'narrow',
      sectionSpacing: 'spacious',
      productCardStyle: 'elevated',
      productCardRadius: 'large',
      testimonialCardStyle: 'elevated',
      testimonialCardRadius: 'large',
      heroStyle: 'split',
      heroAlignment: 'center',
      productGridDensity: 'relaxed',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Skincare, simplified.',
        'Clean formulas for your everyday ritual.',
        'Shop Skincare',
        330,
        'medium',
      ),
      featureList('Clean by design', [
        {
          icon: 'droplet',
          title: 'Clean Formulas',
          description: 'No parabens, sulfates, or synthetic fragrance.',
        },
        {
          icon: 'heart',
          title: 'Cruelty-Free',
          description: 'Never tested on animals, ever.',
        },
        {
          icon: 'shield',
          title: 'Dermatologist Tested',
          description: 'Formulated with dermatologists, for every skin type.',
        },
      ]),
      productCatalog('Shop Skincare'),
      testimonials(
        'My skin has never felt this calm — and it smells incredible.',
        'Hana S.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'volt',
    name: 'Volt',
    category: 'electronics',
    tags: ['futuristic', 'tech', 'modern'],
    description:
      'Futuristic electronics — a crisp geometric grid with structured, specification-style cards.',
    theme: colors({
      primaryColor: '#2563EB',
      accentColor: '#0EA5E9',
      bgColor: '#F7F9FC',
      textColor: '#10151C',
      font: 'Roboto',
      buttonRadius: 'small',
      imageRadius: 'small',
      typeScale: 'compact',
      sectionSpacing: 'compact',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
      testimonialCardStyle: 'outlined',
      testimonialCardRadius: 'small',
      heroStyle: 'split',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Engineered for everyday.',
        'Thoughtfully designed tech, built to last.',
        'Shop Tech',
        370,
        'medium',
      ),
      specTable('At a Glance', [
        { label: 'Battery Life', value: 'Up to 30 hours' },
        { label: 'Warranty', value: '2 years' },
        { label: 'Fast Charging', value: 'Yes — 0 to 80% in 25 min' },
      ]),
      productCatalog('Shop Tech'),
      trustBadges(),
      newsletter(),
    ],
  },
  // ── The remaining 34 — one full pass across all 11 categories, each with
  // its own genuinely distinct layout (not a recolor): different hero
  // style/alignment, header/footer style, product card treatment, section
  // composition/order, and real authored copy. ──────────────────────────
  {
    slug: 'trendy',
    name: 'Trendy',
    category: 'fashion',
    tags: ['young', 'energetic', 'fashion'],
    description:
      'Young, high-energy fashion — punchy color, playful type, and a fast-moving grid for a Gen-Z wardrobe.',
    theme: colors({
      primaryColor: '#FF2E93',
      accentColor: '#2EE6D6',
      bgColor: '#FFFFFF',
      textColor: '#161616',
      font: 'Space Grotesk',
      buttonStyle: 'solid',
      buttonRadius: 'full',
      buttonSize: 'lg',
      imageRadius: 'full',
      productCardStyle: 'elevated',
      productCardRadius: 'full',
      productImageHover: 'zoom',
      productGridDensity: 'relaxed',
      heroStyle: 'overlay',
      heroAlignment: 'center',
      testimonialStyle: 'minimal',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Drop Culture.',
        "This week's picks, before they're gone.",
        'Shop the Drop',
        500,
        'medium',
      ),
      statsCounter([
        { value: '2M+', label: 'Followers' },
        { value: '#1', label: 'Trending Brand' },
        { value: 'New', label: 'Drops Weekly' },
      ]),
      productCatalog('Trending Now'),
      galleryGrid('As Worn By You', [503, 504, 505]),
      newsletter(),
    ],
  },
  {
    slug: 'glow',
    name: 'Glow',
    category: 'beauty',
    tags: ['cosmetics', 'modern', 'vibrant'],
    description:
      'Modern cosmetics — bold, radiant color and a playful grid built for makeup and color-driven beauty.',
    theme: colors({
      primaryColor: '#FF5DA2',
      accentColor: '#FFD23F',
      bgColor: '#FFF9FB',
      textColor: '#2B1B22',
      font: 'Poppins',
      buttonStyle: 'soft',
      buttonRadius: 'full',
      imageRadius: 'full',
      productCardStyle: 'elevated',
      productCardRadius: 'full',
      productImageHover: 'zoom',
      productGridDensity: 'relaxed',
      heroStyle: 'split',
      heroAlignment: 'center',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Color that glows.',
        'Vivid, buildable, made for every skin tone.',
        'Shop Makeup',
        510,
      ),
      galleryGrid('Shade Gallery', [513, 514, 515]),
      productCatalog('Best Sellers'),
      testimonials(
        'The pigment payoff is unreal — one swipe and done.',
        'Zara M.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'blossom',
    name: 'Blossom',
    category: 'beauty',
    tags: ['feminine', 'soft', 'floral'],
    description:
      'Feminine beauty — pastel palette, floral warmth, and a gentle, rounded storefront.',
    theme: colors({
      primaryColor: '#E7A0B7',
      accentColor: '#F4C9D6',
      bgColor: '#FFF6F8',
      textColor: '#3A2530',
      font: 'Lora',
      buttonStyle: 'soft',
      buttonRadius: 'large',
      imageRadius: 'large',
      productCardStyle: 'outlined',
      productCardRadius: 'large',
      heroStyle: 'overlay',
      heroAlignment: 'center',
      sectionSpacing: 'spacious',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Soft beauty, in bloom.',
        'Gentle formulas inspired by nature.',
        'Shop the Collection',
        520,
        'medium',
      ),
      featureList('Made with care', [
        {
          icon: 'leaf',
          title: 'Botanical',
          description: 'Plant-based actives in every formula.',
        },
        {
          icon: 'heart',
          title: 'Gentle',
          description: 'Fragrance-free options for sensitive skin.',
        },
        {
          icon: 'sparkles',
          title: 'Radiant Finish',
          description: 'A soft glow, never greasy.',
        },
      ]),
      productCatalog('Shop the Collection'),
      testimonials(
        'Smells like a garden, feels like silk.',
        'Rosa T.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'pure',
    name: 'Pure',
    category: 'beauty',
    tags: ['clean', 'natural', 'minimal'],
    description:
      'Clean, natural beauty — a stripped-back palette that puts ingredients front and center.',
    theme: colors({
      primaryColor: '#5B8C5A',
      accentColor: '#A7C4A0',
      bgColor: '#FBFBF7',
      textColor: '#232821',
      font: 'Inter',
      buttonStyle: 'outline',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'flat',
      productCardRadius: 'small',
      containerWidth: 'narrow',
      typeScale: 'compact',
      testimonialStyle: 'minimal',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Nothing but the essentials.',
        'Ingredient lists you can actually read.',
        'Shop Clean Beauty',
        530,
        'medium',
      ),
      specTable('What’s Inside (and What’s Not)', [
        { label: 'Parabens', value: 'Never' },
        { label: 'Sulfates', value: 'Never' },
        { label: 'Active Ingredients', value: 'Always disclosed' },
      ]),
      productCatalog('Shop Clean Beauty'),
      newsletter(),
    ],
  },
  {
    slug: 'nexus',
    name: 'Nexus',
    category: 'electronics',
    tags: ['tech', 'marketplace', 'modern'],
    description:
      'A modern technology marketplace — dense, structured, and built for comparison shopping.',
    theme: colors({
      primaryColor: '#7C3AED',
      accentColor: '#38BDF8',
      bgColor: '#0F1117',
      textColor: '#F1F1F5',
      font: 'DM Sans',
      buttonStyle: 'solid',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
      productGridDensity: 'cozy',
      typeScale: 'compact',
      containerWidth: 'wide',
      heroStyle: 'split',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Everything tech, in one place.',
        'Compare, choose, and check out with confidence.',
        'Browse Tech',
        540,
        'medium',
      ),
      specTable('Platform Highlights', [
        { label: 'Products Listed', value: '10,000+' },
        { label: 'Verified Sellers', value: '500+' },
        { label: 'Avg. Delivery', value: '3 days' },
      ]),
      productCatalog('Top Rated This Week'),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'circuit',
    name: 'Circuit',
    category: 'electronics',
    tags: ['dark', 'high-tech', 'gaming'],
    description:
      'Dark, high-tech electronics — a bold night-mode storefront for gaming and performance gear.',
    theme: colors({
      primaryColor: '#00E5A0',
      accentColor: '#FF3D71',
      bgColor: '#08090C',
      textColor: '#E8FFF4',
      font: 'Space Grotesk',
      buttonStyle: 'solid',
      buttonRadius: 'none',
      imageRadius: 'none',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      productImageHover: 'zoom',
      heroStyle: 'overlay',
      heroAlignment: 'left',
      sectionSpacing: 'compact',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero('Power up.', 'Gear built for the win.', 'Shop Gaming Gear', 550),
      statsCounter([
        { value: '240Hz', label: 'Peak Refresh' },
        { value: '<1ms', label: 'Response Time' },
        { value: '5-Star', label: 'Rated by Gamers' },
      ]),
      productCatalog('Shop Gaming Gear'),
      galleryGrid('Setups We Love', [553, 554, 555]),
      newsletter(),
    ],
  },
  {
    slug: 'pixel',
    name: 'Pixel',
    category: 'electronics',
    tags: ['clean', 'modern', 'minimal'],
    description:
      'Clean, modern electronics — a crisp, minimal storefront that lets the product photography do the talking.',
    theme: colors({
      primaryColor: '#111827',
      accentColor: '#3B82F6',
      bgColor: '#FFFFFF',
      textColor: '#111827',
      font: 'Inter',
      buttonStyle: 'outline',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'flat',
      productCardRadius: 'small',
      containerWidth: 'narrow',
      typeScale: 'compact',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Designed to disappear.',
        'Technology that gets out of your way.',
        'Shop Now',
        560,
        'medium',
      ),
      productCatalog('Shop Now'),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'gemora',
    name: 'Gemora',
    category: 'jewelry',
    tags: ['premium', 'gemstones', 'elegant'],
    description:
      'Premium jewelry — rich jewel tones and elegant typography for gemstone-led collections.',
    theme: colors({
      primaryColor: '#7C2D5B',
      accentColor: '#D4AF37',
      bgColor: '#FBF6F9',
      textColor: '#2B1A26',
      font: 'Playfair Display',
      buttonStyle: 'outline',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
      heroStyle: 'split',
      heroAlignment: 'left',
      containerWidth: 'wide',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Color, captured.',
        'Gemstones sourced and set with intention.',
        'Explore Gemstones',
        570,
      ),
      galleryGrid('The Gem Vault', [573, 574, 575]),
      productCatalog('Featured Pieces'),
      testimonials(
        'Every gem tells its own story — mine is my favorite piece now.',
        'Isabelle R.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'lumine',
    name: 'Luminé',
    category: 'jewelry',
    tags: ['minimalist', 'elegant', 'light'],
    description:
      'Elegant minimalist jewelry — light, airy, and quietly luxurious.',
    theme: colors({
      primaryColor: '#B8860B',
      accentColor: '#E8DCC4',
      bgColor: '#FFFFFF',
      textColor: '#1E1B16',
      font: 'Fraunces',
      buttonStyle: 'outline',
      buttonRadius: 'none',
      imageRadius: 'none',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      heroAlignment: 'center',
      sectionSpacing: 'spacious',
      containerWidth: 'narrow',
      typeScale: 'spacious',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Less. Lighter. Luminous.',
        'Fine jewelry, pared back to its essence.',
        'Discover',
        580,
        'medium',
      ),
      productCatalog('Discover'),
      testimonials(
        'Understated and stunning — exactly what I wanted.',
        'Claire B.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'heritage',
    name: 'Heritage',
    category: 'jewelry',
    tags: ['classic', 'timeless', 'traditional'],
    description:
      'Classic jewelry — timeless composition and warm, traditional craftsmanship.',
    theme: colors({
      primaryColor: '#8B5A2B',
      accentColor: '#C9A063',
      bgColor: '#FAF6EF',
      textColor: '#2C2213',
      font: 'Playfair Display',
      buttonStyle: 'solid',
      buttonRadius: 'small',
      imageRadius: 'medium',
      productCardStyle: 'outlined',
      productCardRadius: 'medium',
      heroStyle: 'overlay',
      heroAlignment: 'left',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Passed down. Cherished forever.',
        'Heirloom-quality jewelry, generation after generation.',
        'Shop Heritage',
        590,
      ),
      featureList('Our Craft', [
        {
          icon: 'award',
          title: 'Master Goldsmiths',
          description: 'Three generations of family craftsmanship.',
        },
        {
          icon: 'shield',
          title: 'Certified Metals',
          description: 'Every piece hallmarked and guaranteed.',
        },
      ]),
      productCatalog('Shop Heritage'),
      newsletter(),
    ],
  },
  {
    slug: 'nordic',
    name: 'Nordic',
    category: 'furniture',
    tags: ['scandinavian', 'light', 'minimal'],
    description:
      'Scandinavian furniture — light wood, soft neutrals, and airy, functional layouts.',
    theme: colors({
      primaryColor: '#3D4A3D',
      accentColor: '#C9A876',
      bgColor: '#F7F5F0',
      textColor: '#26251F',
      font: 'DM Sans',
      buttonStyle: 'outline',
      buttonRadius: 'small',
      imageRadius: 'medium',
      productCardStyle: 'flat',
      productCardRadius: 'small',
      heroStyle: 'split',
      containerWidth: 'wide',
      sectionSpacing: 'spacious',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Light, functional, timeless.',
        'Furniture designed for everyday living.',
        'Shop the Collection',
        600,
      ),
      galleryGrid('Room Inspiration', [603, 604, 605]),
      specTable('Materials', [
        { label: 'Wood', value: 'FSC-certified oak & ash' },
        { label: 'Finish', value: 'Water-based, low-VOC' },
      ]),
      productCatalog('Shop the Collection'),
      newsletter(),
    ],
  },
  {
    slug: 'casa',
    name: 'Casa',
    category: 'furniture',
    tags: ['warm', 'home', 'cozy'],
    description:
      'Warm modern home furnishings — cozy palette, inviting layout, lived-in comfort.',
    theme: colors({
      primaryColor: '#B5651D',
      accentColor: '#E8C39E',
      bgColor: '#FBF4EC',
      textColor: '#332217',
      font: 'Nunito',
      buttonStyle: 'solid',
      buttonRadius: 'large',
      imageRadius: 'large',
      productCardStyle: 'outlined',
      productCardRadius: 'large',
      heroStyle: 'overlay',
      heroAlignment: 'left',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Make it home.',
        'Furniture and decor that feels lived-in from day one.',
        'Shop Casa',
        610,
      ),
      featureList('Why Casa', [
        {
          icon: 'heart',
          title: 'Comfort First',
          description: 'Every piece tested for everyday living.',
        },
        {
          icon: 'leaf',
          title: 'Sustainably Sourced',
          description: 'Responsibly harvested materials.',
        },
        {
          icon: 'award',
          title: '10-Year Warranty',
          description: 'Built to last, guaranteed.',
        },
      ]),
      productCatalog('Shop Casa'),
      testimonials(
        'Our living room finally feels finished.',
        'The Alvarez Family',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'loft',
    name: 'Loft',
    category: 'furniture',
    tags: ['industrial', 'urban', 'raw'],
    description:
      'Industrial furniture — raw materials, exposed structure, and an urban, edge-to-edge grid.',
    theme: colors({
      primaryColor: '#43302B',
      accentColor: '#C05621',
      bgColor: '#F0EDE8',
      textColor: '#1F1B18',
      font: 'Roboto',
      buttonStyle: 'solid',
      buttonRadius: 'none',
      imageRadius: 'none',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      heroStyle: 'split',
      containerWidth: 'wide',
      sectionSpacing: 'compact',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Raw materials. Real character.',
        'Industrial furniture for modern lofts.',
        'Shop the Loft Line',
        620,
      ),
      productCatalog('Shop the Loft Line'),
      specTable('Build Specs', [
        { label: 'Frame', value: 'Powder-coated steel' },
        { label: 'Surface', value: 'Reclaimed wood' },
      ]),
      galleryGrid('Loft Living', [623, 624, 625]),
      newsletter(),
    ],
  },
  {
    slug: 'haven',
    name: 'Haven',
    category: 'furniture',
    tags: ['luxury', 'interior', 'refined'],
    description:
      'Luxury interior furniture — refined materials and a spacious, gallery-like presentation.',
    theme: colors({
      primaryColor: '#1C1C1E',
      accentColor: '#B08D57',
      bgColor: '#FDFCFA',
      textColor: '#1C1C1E',
      font: 'Playfair Display',
      buttonStyle: 'outline',
      buttonRadius: 'none',
      imageRadius: 'none',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      heroAlignment: 'center',
      sectionSpacing: 'spacious',
      containerWidth: 'wide',
      typeScale: 'spacious',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'A sanctuary, furnished.',
        'Refined pieces for considered interiors.',
        'View the Collection',
        630,
        'medium',
      ),
      galleryGrid('Interiors', [633, 634, 635]),
      productCatalog('View the Collection'),
      testimonials(
        'Every piece feels museum-quality — and it’s in my living room.',
        'Delphine A.',
        'Verified Buyer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'harvest',
    name: 'Harvest',
    category: 'food',
    tags: ['organic', 'seasonal', 'farm'],
    description:
      'Organic food — earthy tones and a seasonal, farm-forward storefront.',
    theme: colors({
      primaryColor: '#6B7D3D',
      accentColor: '#C68642',
      bgColor: '#FBF8F0',
      textColor: '#2A2A1E',
      font: 'Nunito',
      buttonStyle: 'solid',
      buttonRadius: 'medium',
      imageRadius: 'large',
      productCardStyle: 'outlined',
      productCardRadius: 'medium',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Grown with the seasons.',
        'Organic produce, harvested at its peak.',
        'Shop This Week’s Harvest',
        640,
      ),
      featureList('Farm to You', [
        {
          icon: 'leaf',
          title: 'Certified Organic',
          description: 'No synthetic pesticides, ever.',
        },
        {
          icon: 'droplet',
          title: 'Picked Fresh',
          description: 'Harvested within 24 hours of delivery.',
        },
      ]),
      productCatalog('This Week’s Harvest'),
      newsletter(),
    ],
  },
  {
    slug: 'dailycart',
    name: 'DailyCart',
    category: 'food',
    tags: ['modern', 'grocery', 'convenient'],
    description:
      'Modern grocery — fast, convenient, and built for the weekly shop.',
    theme: colors({
      primaryColor: '#0EA5E9',
      accentColor: '#F97316',
      bgColor: '#FFFFFF',
      textColor: '#0F172A',
      font: 'DM Sans',
      buttonStyle: 'solid',
      buttonRadius: 'full',
      imageRadius: 'small',
      productCardStyle: 'elevated',
      productCardRadius: 'small',
      productGridDensity: 'relaxed',
      heroStyle: 'split',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Groceries, delivered daily.',
        'Fresh essentials, on your schedule.',
        'Start Shopping',
        650,
        'medium',
      ),
      statsCounter([
        { value: '2hr', label: 'Delivery Window' },
        { value: '5,000+', label: 'Products' },
        { value: '4.9★', label: 'Rated by Shoppers' },
      ]),
      productCatalog('Shop Essentials'),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'greenbasket',
    name: 'GreenBasket',
    category: 'food',
    tags: ['natural', 'wholesome', 'eco'],
    description: 'Natural food — wholesome, eco-conscious, and gently branded.',
    theme: colors({
      primaryColor: '#2F6844',
      accentColor: '#F2C14E',
      bgColor: '#F6F8F1',
      textColor: '#213321',
      font: 'Lora',
      buttonStyle: 'soft',
      buttonRadius: 'full',
      imageRadius: 'large',
      productCardStyle: 'outlined',
      productCardRadius: 'large',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Nature, in every basket.',
        'Wholesome staples, thoughtfully sourced.',
        'Shop Wholesome',
        660,
        'medium',
      ),
      featureList('Why GreenBasket', [
        {
          icon: 'leaf',
          title: 'Eco Packaging',
          description: 'Compostable, plastic-free packaging.',
        },
        {
          icon: 'heart',
          title: 'Small Producers',
          description: 'Sourced from family farms we know by name.',
        },
      ]),
      productCatalog('Shop Wholesome'),
      newsletter(),
    ],
  },
  {
    slug: 'bistro',
    name: 'Bistro',
    category: 'restaurant',
    tags: ['premium', 'dining', 'elegant'],
    description:
      'A premium restaurant storefront — elegant menu presentation, reservations, and location up front.',
    theme: colors({
      primaryColor: '#7A1F2B',
      accentColor: '#D4A24C',
      bgColor: '#FBF8F5',
      textColor: '#241412',
      font: 'Playfair Display',
      buttonStyle: 'outline',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
      heroStyle: 'overlay',
      heroAlignment: 'center',
    }),
    header: header('centered'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'An evening to remember.',
        'Seasonal French bistro fare, in the heart of the city.',
        'Reserve a Table',
        670,
        'medium',
      ),
      menuList('The Menu', 'A taste of tonight’s offerings', [
        {
          name: 'Seared Scallops',
          description: 'Brown butter, capers, lemon',
          price: 24,
          category: 'Starters',
        },
        {
          name: 'Duck Confit',
          description: 'Fondant potato, red wine jus',
          price: 36,
          category: 'Mains',
        },
        {
          name: 'Tarte Tatin',
          description: 'Vanilla bean ice cream',
          price: 14,
          category: 'Desserts',
        },
      ]),
      teamGrid('Meet the Kitchen', [
        { name: 'Chef Marcel Dubois', role: 'Executive Chef' },
        { name: 'Chef Anaïs Roy', role: 'Pastry Chef' },
      ]),
      locationInfo(
        'Visit Us',
        '128 Rue de la Table, Downtown',
        'Tue–Sun: 5pm–11pm · Closed Mondays',
      ),
    ],
  },
  {
    slug: 'savor',
    name: 'Savor',
    category: 'restaurant',
    tags: ['modern', 'dining', 'casual-upscale'],
    description:
      'Modern dining — a fresh, casual-upscale layout for contemporary restaurants.',
    theme: colors({
      primaryColor: '#D9480F',
      accentColor: '#2B8A3E',
      bgColor: '#FFFDF9',
      textColor: '#241C15',
      font: 'DM Sans',
      buttonStyle: 'solid',
      buttonRadius: 'full',
      imageRadius: 'large',
      productCardStyle: 'elevated',
      productCardRadius: 'large',
      heroStyle: 'split',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Modern plates, honest flavor.',
        'Seasonal menu, made from scratch daily.',
        'View Menu & Book',
        680,
      ),
      menuList('Tonight’s Menu', '', [
        {
          name: 'Charred Cauliflower',
          description: 'Tahini, pomegranate, mint',
          price: 12,
          category: 'Small Plates',
        },
        {
          name: 'Grilled Ribeye',
          description: 'Chimichurri, roasted potatoes',
          price: 32,
          category: 'Mains',
        },
      ]),
      galleryGrid('Inside Savor', [683, 684, 685]),
      locationInfo(
        'Find Us',
        '42 Market Street, Riverside',
        'Mon–Sat: 11am–10pm',
      ),
    ],
  },
  {
    slug: 'ember',
    name: 'Ember',
    category: 'restaurant',
    tags: ['dark', 'luxury', 'steakhouse'],
    description:
      'Dark luxury restaurant — a moody steakhouse aesthetic built for evening dining.',
    theme: colors({
      primaryColor: '#C1272D',
      accentColor: '#D9A441',
      bgColor: '#141110',
      textColor: '#F2E9E4',
      font: 'Fraunces',
      buttonStyle: 'outline',
      buttonRadius: 'none',
      imageRadius: 'none',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      heroStyle: 'overlay',
      heroAlignment: 'center',
      sectionSpacing: 'spacious',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Fire. Smoke. Flavor.',
        'Dry-aged steaks, open-flame grilled.',
        'Reserve Your Table',
        690,
        'medium',
      ),
      menuList('The Fire Menu', '', [
        {
          name: 'Dry-Aged Ribeye (16oz)',
          description: '45-day aged, bone-in',
          price: 68,
          category: 'Steaks',
        },
        {
          name: 'Smoked Bone Marrow',
          description: 'Charred bread, sea salt',
          price: 18,
          category: 'Starters',
        },
      ]),
      teamGrid('Behind the Grill', [
        { name: 'Chef Raymond Okafor', role: 'Head of Grill' },
      ]),
      locationInfo(
        'Reserve',
        '9 Ember Lane, Old Town',
        'Wed–Sun: 6pm–midnight',
      ),
    ],
  },
  {
    slug: 'taste',
    name: 'Taste',
    category: 'restaurant',
    tags: ['casual', 'friendly', 'family'],
    description:
      'Casual food restaurant — friendly, colorful, and built for quick, family-friendly ordering.',
    theme: colors({
      primaryColor: '#FF6B35',
      accentColor: '#FFD23F',
      bgColor: '#FFFBF5',
      textColor: '#2A2018',
      font: 'Nunito',
      buttonStyle: 'solid',
      buttonRadius: 'full',
      imageRadius: 'large',
      productCardStyle: 'elevated',
      productCardRadius: 'full',
      productGridDensity: 'relaxed',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Good food, fast and friendly.',
        'Order online, ready in 15 minutes.',
        'Order Now',
        700,
        'medium',
      ),
      menuList('What’s Cooking', '', [
        {
          name: 'Classic Burger Combo',
          description: 'Fries + drink included',
          price: 11,
          category: 'Combos',
        },
        {
          name: 'Family Feast',
          description: 'Feeds 4, mix & match sides',
          price: 34,
          category: 'Family Meals',
        },
      ]),
      trustBadges(),
      locationInfo('Visit or Order', '77 Main Street', 'Daily: 10am–10pm'),
      newsletter(),
    ],
  },
  {
    slug: 'scholar',
    name: 'Scholar',
    category: 'education',
    tags: ['academic', 'serious', 'courses'],
    description:
      'Academic education — a serious, structured layout for rigorous course catalogs.',
    theme: colors({
      primaryColor: '#1E3A5F',
      accentColor: '#C9A227',
      bgColor: '#FAFAF7',
      textColor: '#1B2430',
      font: 'Lora',
      buttonStyle: 'solid',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
      containerWidth: 'wide',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Rigorous learning, real credentials.',
        'Courses designed by working academics.',
        'Browse Courses',
        710,
      ),
      specTable('Why Scholar', [
        { label: 'Accredited Courses', value: '120+' },
        { label: 'Faculty', value: 'PhD-led' },
        { label: 'Completion Rate', value: '87%' },
      ]),
      productCatalog('Browse Courses'),
      testimonials(
        'The rigor here is unmatched — I learned more in 8 weeks than a semester elsewhere.',
        'Daniel K.',
        'Graduate',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'academy',
    name: 'Academy',
    category: 'education',
    tags: ['professional', 'career', 'certification'],
    description:
      'Professional education — career-focused, certification-driven, and outcome-oriented.',
    theme: colors({
      primaryColor: '#0F766E',
      accentColor: '#F59E0B',
      bgColor: '#FFFFFF',
      textColor: '#0F172A',
      font: 'Inter',
      buttonStyle: 'solid',
      buttonRadius: 'medium',
      imageRadius: 'medium',
      productCardStyle: 'elevated',
      productCardRadius: 'medium',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Skills that get you hired.',
        'Career certificates built with industry partners.',
        'View Programs',
        720,
        'medium',
      ),
      statsCounter([
        { value: '92%', label: 'Job Placement' },
        { value: '40+', label: 'Certifications' },
        { value: '15k+', label: 'Graduates' },
      ]),
      productCatalog('View Programs'),
      teamGrid('Learn From', [
        { name: 'Priya Anand', role: 'Lead Instructor, Data' },
        { name: 'Marcus Webb', role: 'Lead Instructor, Design' },
      ]),
      newsletter(),
    ],
  },
  {
    slug: 'learnly',
    name: 'Learnly',
    category: 'education',
    tags: ['modern', 'online', 'friendly'],
    description:
      'Modern online learning — friendly, colorful, and built for self-paced learners.',
    theme: colors({
      primaryColor: '#6D28D9',
      accentColor: '#22D3EE',
      bgColor: '#FAFAFF',
      textColor: '#1E1B2E',
      font: 'DM Sans',
      buttonStyle: 'soft',
      buttonRadius: 'full',
      imageRadius: 'large',
      productCardStyle: 'elevated',
      productCardRadius: 'large',
      productGridDensity: 'relaxed',
      heroStyle: 'split',
      heroAlignment: 'center',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Learn anything, anytime.',
        'Bite-sized courses that fit your life.',
        'Start Learning',
        730,
        'medium',
      ),
      featureList('Learn Your Way', [
        {
          icon: 'star',
          title: 'Self-Paced',
          description: 'No deadlines, learn on your schedule.',
        },
        {
          icon: 'award',
          title: 'Real Certificates',
          description: 'Share your progress on any resume.',
        },
      ]),
      productCatalog('Popular Courses'),
      testimonials(
        'I finally finished a course — the format just clicks for me.',
        'Ade O.',
        'Student',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'campus',
    name: 'Campus',
    category: 'education',
    tags: ['university', 'community', 'structured'],
    description:
      'University/course platform — structured, community-driven, and built around cohorts.',
    theme: colors({
      primaryColor: '#B91C1C',
      accentColor: '#1E293B',
      bgColor: '#FFFFFF',
      textColor: '#1E293B',
      font: 'Roboto',
      buttonStyle: 'solid',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Your cohort starts soon.',
        'Structured programs, real classmates, live support.',
        'See Upcoming Cohorts',
        740,
      ),
      productCatalog('Upcoming Cohorts'),
      teamGrid('Program Leads', [
        { name: 'Dr. Elena Cross', role: 'Program Director' },
      ]),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'pixelstore',
    name: 'PixelStore',
    category: 'digital_products',
    tags: ['assets', 'creative', 'downloads'],
    description:
      'Digital assets — a creative, grid-forward store for design files, templates, and assets.',
    theme: colors({
      primaryColor: '#4F46E5',
      accentColor: '#F472B6',
      bgColor: '#0B0F19',
      textColor: '#EEF1FF',
      font: 'Space Grotesk',
      buttonStyle: 'solid',
      buttonRadius: 'medium',
      imageRadius: 'medium',
      productCardStyle: 'outlined',
      productCardRadius: 'medium',
      heroStyle: 'split',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Design faster.',
        'Templates, mockups, and UI kits — instant download.',
        'Browse Assets',
        750,
        'medium',
      ),
      specTable('What You Get', [
        { label: 'File Formats', value: 'Figma, Sketch, PNG, SVG' },
        { label: 'License', value: 'Commercial use included' },
        { label: 'Updates', value: 'Free lifetime updates' },
      ]),
      productCatalog('Browse Assets'),
      newsletter(),
    ],
  },
  {
    slug: 'creator',
    name: 'Creator',
    category: 'digital_products',
    tags: ['creator', 'community', 'personal'],
    description:
      'A creator marketplace — personal, community-driven, built around a single creator’s catalog.',
    theme: colors({
      primaryColor: '#F59E0B',
      accentColor: '#EC4899',
      bgColor: '#FFFCF7',
      textColor: '#241C0F',
      font: 'Poppins',
      buttonStyle: 'soft',
      buttonRadius: 'full',
      imageRadius: 'large',
      productCardStyle: 'elevated',
      productCardRadius: 'large',
      heroStyle: 'split',
      heroAlignment: 'center',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Everything I make, in one place.',
        'Presets, guides, and templates from my own workflow.',
        'Shop My Products',
        760,
        'medium',
      ),
      teamGrid('Hi, I’m the creator', [
        {
          name: 'Jordan Ellis',
          role: 'Photographer & Educator',
          bio: 'Sharing what I’ve learned over 10 years behind the camera.',
        },
      ]),
      productCatalog('Shop My Products'),
      testimonials(
        'Feels like getting mentored, not just buying a file.',
        'Priya D.',
        'Customer',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'downloadly',
    name: 'Downloadly',
    category: 'digital_products',
    tags: ['downloads', 'simple', 'clean'],
    description:
      'Digital downloads — a simple, no-friction storefront optimized for instant purchase-and-download.',
    theme: colors({
      primaryColor: '#2563EB',
      accentColor: '#10B981',
      bgColor: '#FFFFFF',
      textColor: '#0F172A',
      font: 'Inter',
      buttonStyle: 'solid',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'flat',
      productCardRadius: 'small',
      containerWidth: 'narrow',
      typeScale: 'compact',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Buy it. Download it. Done.',
        'Instant delivery on every purchase.',
        'Browse Downloads',
        770,
        'medium',
      ),
      productCatalog('Browse Downloads'),
      trustBadges(),
      newsletter(),
    ],
  },
  {
    slug: 'studio',
    name: 'Studio',
    category: 'digital_products',
    tags: ['premium', 'portfolio', 'design'],
    description:
      'Premium digital products — a portfolio-grade presentation for high-end design goods.',
    theme: colors({
      primaryColor: '#111111',
      accentColor: '#D4AF37',
      bgColor: '#FAFAFA',
      textColor: '#111111',
      font: 'Fraunces',
      buttonStyle: 'outline',
      buttonRadius: 'none',
      imageRadius: 'none',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      heroAlignment: 'center',
      sectionSpacing: 'spacious',
      containerWidth: 'wide',
      typeScale: 'spacious',
    }),
    header: header('centered'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'Crafted digital goods.',
        'Premium templates and tools, designed to be seen.',
        'View the Studio',
        780,
        'medium',
      ),
      galleryGrid('Selected Work', [783, 784, 785]),
      productCatalog('View the Studio'),
      newsletter(),
    ],
  },
  {
    slug: 'proservice',
    name: 'ProService',
    category: 'services',
    tags: ['professional', 'trust', 'clean'],
    description:
      'Professional services — a clean, trust-building layout for consultants and service providers.',
    theme: colors({
      primaryColor: '#1D4ED8',
      accentColor: '#0EA5E9',
      bgColor: '#FFFFFF',
      textColor: '#111827',
      font: 'Inter',
      buttonStyle: 'solid',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Expertise you can trust.',
        'Professional services, delivered on time, every time.',
        'View Services',
        790,
        'medium',
      ),
      specTable('Our Services', [
        { label: 'Response Time', value: 'Within 24 hours' },
        { label: 'Satisfaction', value: '98% client retention' },
      ]),
      trustBadges(),
      testimonials(
        'Professional from the first call to the final delivery.',
        'Michael T.',
        'Client',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'consult',
    name: 'Consult',
    category: 'services',
    tags: ['consulting', 'sharp', 'strategic'],
    description:
      'Consulting — a sharp, strategic layout that leads with outcomes and credentials.',
    theme: colors({
      primaryColor: '#0F172A',
      accentColor: '#F59E0B',
      bgColor: '#F8FAFC',
      textColor: '#0F172A',
      font: 'DM Sans',
      buttonStyle: 'solid',
      buttonRadius: 'none',
      imageRadius: 'small',
      productCardStyle: 'flat',
      productCardRadius: 'small',
      containerWidth: 'wide',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Strategy that ships.',
        'Consulting engagements built around measurable outcomes.',
        'Book a Consultation',
        800,
      ),
      statsCounter([
        { value: '$40M+', label: 'Client Revenue Impact' },
        { value: '150+', label: 'Engagements' },
        { value: '15 yrs', label: 'Combined Experience' },
      ]),
      teamGrid('Our Consultants', [
        { name: 'Rachel Kim', role: 'Managing Partner' },
        { name: 'Oliver Grant', role: 'Senior Strategist' },
      ]),
      newsletter(),
    ],
  },
  {
    slug: 'agency',
    name: 'Agency',
    category: 'services',
    tags: ['creative', 'bold', 'portfolio'],
    description:
      'Creative agency — bold typography and a portfolio-first layout for studios and freelancers.',
    theme: colors({
      primaryColor: '#FF3B30',
      accentColor: '#111111',
      bgColor: '#FFFFFF',
      textColor: '#111111',
      font: 'Space Grotesk',
      buttonStyle: 'solid',
      buttonRadius: 'none',
      imageRadius: 'none',
      productCardStyle: 'flat',
      productCardRadius: 'none',
      heroStyle: 'split',
      typeScale: 'spacious',
      sectionSpacing: 'spacious',
      containerWidth: 'wide',
    }),
    header: header('standard'),
    footer: footer('minimal'),
    homePageSections: [
      hero(
        'We make brands unforgettable.',
        'A creative studio for bold, ambitious ideas.',
        'See Our Work',
        810,
      ),
      galleryGrid('Selected Work', [813, 814, 815]),
      teamGrid('The Studio', [
        { name: 'Noah Reyes', role: 'Creative Director' },
        { name: 'Fatima Sy', role: 'Lead Designer' },
      ]),
      newsletter(),
    ],
  },
  {
    slug: 'expert',
    name: 'Expert',
    category: 'services',
    tags: ['freelancer', 'marketplace', 'trust'],
    description:
      'A freelancer/service marketplace — trust signals up front, built for booking independent experts.',
    theme: colors({
      primaryColor: '#059669',
      accentColor: '#F59E0B',
      bgColor: '#FFFFFF',
      textColor: '#0F172A',
      font: 'Nunito',
      buttonStyle: 'soft',
      buttonRadius: 'full',
      imageRadius: 'medium',
      productCardStyle: 'elevated',
      productCardRadius: 'medium',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Book the right expert, fast.',
        'Vetted professionals, transparent pricing, real reviews.',
        'Find an Expert',
        820,
        'medium',
      ),
      trustBadges(),
      productCatalog('Top Rated Experts'),
      testimonials(
        'Booked, paid, and done in ten minutes — exactly what I needed.',
        'Grace L.',
        'Client',
      ),
      newsletter(),
    ],
  },
  {
    slug: 'marketx',
    name: 'MarketX',
    category: 'general',
    tags: ['marketplace', 'bold', 'universal'],
    description:
      'A marketplace-flavored general store — bold, structured, built for a wide, varied catalog.',
    theme: colors({
      primaryColor: '#EA580C',
      accentColor: '#0EA5E9',
      bgColor: '#FFFFFF',
      textColor: '#1C1917',
      font: 'DM Sans',
      buttonStyle: 'solid',
      buttonRadius: 'small',
      imageRadius: 'small',
      productCardStyle: 'outlined',
      productCardRadius: 'small',
      containerWidth: 'wide',
      productGridDensity: 'relaxed',
    }),
    header: header('standard'),
    footer: footer('columns'),
    homePageSections: [
      hero(
        'Everything you need, one marketplace.',
        'Thousands of products, one seamless checkout.',
        'Start Browsing',
        830,
      ),
      featureList('Why Shop Here', [
        {
          icon: 'shield',
          title: 'Buyer Protection',
          description: 'Every order covered, every time.',
        },
        {
          icon: 'star',
          title: 'Verified Sellers',
          description: 'Rated and reviewed by real buyers.',
        },
      ]),
      productCatalog('Start Browsing'),
      trustBadges(),
      newsletter(),
    ],
  },
] as const;

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const themeDefinitions = db.collection('themedefinitions');
  let created = 0;
  let updated = 0;

  for (const t of THEMES) {
    const doc = {
      slug: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      tags: [...t.tags],
      version: 1,
      thumbnail: null,
      screenshots: [],
      status: 'published',
      featured: false,
      tier: 'free',
      badge: null,
      theme: t.theme,
      header: t.header,
      footer: t.footer,
      identityBanner: IDENTITY_BANNER_DEFAULT,
      homePageSections: t.homePageSections,
      viewCount: 0,
      applyCount: 0,
    };
    const res = await themeDefinitions.updateOne(
      { slug: t.slug },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    if (res.upsertedCount > 0) created++;
    else updated++;
  }

  console.log(
    `Theme catalog seed complete — ${created} created, ${updated} updated (${THEMES.length} total).`,
  );
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
