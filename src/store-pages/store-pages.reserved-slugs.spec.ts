/* eslint-disable prettier/prettier */
import { readFileSync } from 'fs';
import { join } from 'path';

// A custom page lives at the bare /:slug/:pageSlug, so its slug must never equal one of the storefront's fixed routes
// (the fixed route wins and the page becomes unreachable). Keeps the reserved list in step with the storefront router.
describe('reserved custom-page slugs', () => {
  const src = readFileSync(join(__dirname, 'store-pages.service.ts'), 'utf8');
  const list = /RESERVED_CUSTOM_PAGE_SLUGS = \[([^\]]*)\]/.exec(src)![1].split(',').map((s) => s.trim().replace(/'/g, ''));
  const FIXED_STOREFRONT_ROUTES = [
    'blog', 'blogs', 'cart', 'checkout', 'login', 'register', 'verify-otp', 'forgot-password', 'new-password', 'account', 'wishlist',
    'loyalty', 'messages', 'notifications', 'returns', 'gift-cards', 'store-credit', 'orders', 'order-status', 'addresses', 'reviews',
    'category', 'collections', 'product', 'search', 'home',
  ];
  it.each(FIXED_STOREFRONT_ROUTES)('reserves "%s"', (slug) => expect(list).toContain(slug));
});
