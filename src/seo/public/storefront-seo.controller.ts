/* eslint-disable prettier/prettier */
import { Controller, Get, Query, Req, Res, NotFoundException, BadRequestException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { DatabaseService } from '@/database/databaseservice';
import { SeoResolutionService } from '../services/seo-resolution.service';
import { SeoRedirectsService } from '../services/seo-redirects.service';

const PLATFORM_ROOT = 'solvexo.store';
const MAX_URLS_PER_SITEMAP = 45_000;

/** Host-routed crawl files for each live merchant storefront. The Vercel
 * storefront edge forwards /robots.txt and /sitemap*.xml here while keeping
 * the original host in X-Forwarded-Host. */
@Controller('api/storefront-seo')
export class StorefrontSeoController {
  constructor(private readonly db: DatabaseService, private readonly seo: SeoResolutionService, private readonly redirects: SeoRedirectsService) {}

  /** Host-aware document metadata and route existence for the Vercel HTML
   * shell. The Vercel function injects these tags into index.html before the
   * browser/crawler receives it and forwards this status as the real HTTP
   * status (including 404). */
  @SkipThrottle()
  @Get('document')
  async document(@Query('host') host: string, @Query('path') path: string) {
    const store = await this.resolveStore(host);
    const routePath = normalizeRoutePath(path);
    const storeId = String((store as any)._id);
    const redirect = await this.redirects.resolve(storeId, routePath);
    if (redirect) return { redirect: redirect.destination, statusCode: redirect.statusCode };
    if (routePath === '/') return this.seo.resolve('store', storeId);

    if (routePath === '/blog') {
      const blog = await this.db.repositories.blogModel.findOne({ storeId, isDelete: false }).sort({ createdAt: 1 }).select('title slug').lean() as any;
      const title = blog?.title || 'Blog';
      const url = `${getCanonicalOrigin(store)}/blog`;
      return { title, description: '', canonicalUrl: url, url, ogTitle: title, ogDescription: '', ogImage: null, noindex: false, jsonLd: [] };
    }

    const productMatch = routePath.match(/^\/product\/([^/]+)$/);
    if (productMatch) {
      const slug = productMatch[1];
      const product = await this.db.repositories.productModel.findOne({ storeId, slug, status: 'active', isDelete: false }).select('_id').lean() as any;
      if (!product) throw new NotFoundException('Store product not found');
      return this.seo.resolve('product', String(product._id));
    }

    const blogMatch = routePath.match(/^\/blog\/([^/]+)$/);
    if (blogMatch) {
      const blog = await this.db.repositories.blogModel.findOne({ storeId, isDelete: false }).sort({ createdAt: 1 }).select('_id title slug').lean() as any;
      const post = await this.db.repositories.blogPostModel.findOne({ storeId, blogId: blog?._id?.toString(), slug: blogMatch[1], status: 'published', isDelete: false }).select('title excerpt seoTitle seoDescription coverImage slug').lean() as any;
      if (!post) throw new NotFoundException('Blog article not found');
      const url = `${getCanonicalOrigin(store)}/blog/${encodeURIComponent(post.slug)}`;
      const title = post.seoTitle || post.title;
      const description = post.seoDescription || post.excerpt || '';
      return { title, description, canonicalUrl: url, url, ogTitle: title, ogDescription: description, ogImage: post.coverImage ?? null, noindex: false, jsonLd: [] };
    }

    const namedBlogMatch = routePath.match(/^\/blogs\/([^/]+)(?:\/([^/]+))?$/);
    if (namedBlogMatch) {
      const blog = await this.db.repositories.blogModel.findOne({ storeId, slug: namedBlogMatch[1], isDelete: false }).select('_id title slug').lean() as any;
      if (!blog) throw new NotFoundException('Blog not found');
      if (!namedBlogMatch[2]) {
        const url = `${getCanonicalOrigin(store)}/blogs/${encodeURIComponent(blog.slug)}`;
        return { title: blog.title, description: '', canonicalUrl: url, url, ogTitle: blog.title, ogDescription: '', ogImage: null, noindex: false, jsonLd: [] };
      }
      const post = await this.db.repositories.blogPostModel.findOne({ storeId, blogId: blog._id.toString(), slug: namedBlogMatch[2], status: 'published', isDelete: false }).select('title excerpt seoTitle seoDescription coverImage slug').lean() as any;
      if (!post) throw new NotFoundException('Blog article not found');
      const url = `${getCanonicalOrigin(store)}/blogs/${encodeURIComponent(blog.slug)}/${encodeURIComponent(post.slug)}`;
      const title = post.seoTitle || post.title;
      const description = post.seoDescription || post.excerpt || '';
      return { title, description, canonicalUrl: url, url, ogTitle: title, ogDescription: description, ogImage: post.coverImage ?? null, noindex: false, jsonLd: [] };
    }

    const collectionMatch = routePath.match(/^\/collections\/([^/]+)$/);
    if (collectionMatch) {
      const segment = collectionMatch[1];
      const idOrSlug = /^[a-f0-9]{24}$/i.test(segment) ? [{ slug: segment }, { _id: segment }] : [{ slug: segment }];
      const collection = await this.db.repositories.collectionModel.findOne({ storeId, status: 'active', isDelete: false, $or: idOrSlug }).select('name description slug').lean() as any;
      if (!collection) throw new NotFoundException('Collection not found');
      const url = `${getCanonicalOrigin(store)}/collections/${encodeURIComponent(collection.slug)}`;
      const title = collection.name || (store as any).name;
      const description = collection.description || '';
      return { title, description, canonicalUrl: url, url, ogTitle: title, ogDescription: description, ogImage: null, noindex: false, jsonLd: [] };
    }

    const categoryMatch = routePath.match(/^\/category\/([^/]+)$/);
    if (categoryMatch) {
      const segment = categoryMatch[1];
      const idOrSlug = /^[a-f0-9]{24}$/i.test(segment) ? [{ slug: segment }, { _id: segment }] : [{ slug: segment }];
      const category = await this.db.repositories.categoryModel.findOne({ storeId, status: 'active', isDelete: false, $or: idOrSlug }).select('name description image slug seo').lean() as any;
      if (!category) throw new NotFoundException('Category not found');
      const seo = category.seo ?? {};
      const url = seo.canonicalUrlOverride || `${getCanonicalOrigin(store)}/category/${encodeURIComponent(category.slug || category._id.toString())}`;
      const title = seo.metaTitle || category.name || (store as any).name;
      const description = seo.metaDescription || seo.metaDesc || category.description || '';
      return { title, description, canonicalUrl: url, url, ogTitle: seo.ogTitle || title, ogDescription: seo.ogDescription || description, ogImage: seo.ogImage ?? category.image ?? null, noindex: !!seo.noindex, jsonLd: [] };
    }

    const pageSlug = routePath.slice(1);
    if (!pageSlug.includes('/') && !BUILT_IN_STOREFRONT_PATHS.has(pageSlug)) {
      const page = await this.db.repositories.storePageModel.findOne({ storeId, type: 'custom', slug: pageSlug, status: 'published', isDelete: false }).select('title seo slug').lean() as any;
      if (!page) throw new NotFoundException('Store page not found');
      const seo = page.seo ?? {};
      const url = seo.canonicalUrlOverride || `${getCanonicalOrigin(store)}/${encodeURIComponent(page.slug)}`;
      const title = seo.metaTitle || page.title || (store as any).name;
      const description = seo.metaDescription || seo.metaDesc || '';
      return { title, description, canonicalUrl: url, url, ogTitle: seo.ogTitle || title, ogDescription: seo.ogDescription || description, ogImage: seo.ogImage ?? null, noindex: !!seo.noindex, jsonLd: [] };
    }

    if (isBuiltInStorefrontPath(routePath)) {
      return { title: (store as any).name, description: '', canonicalUrl: `${getCanonicalOrigin(store)}${routePath}`, url: `${getCanonicalOrigin(store)}${routePath}`, ogTitle: (store as any).name, ogDescription: '', ogImage: null, noindex: true, jsonLd: [] };
    }
    throw new NotFoundException('Storefront page not found');
  }

  @SkipThrottle()
  @Get('robots.txt')
  async robots(@Req() req: any, @Query('host') explicitHost: string | undefined, @Res() res: Response) {
    const store = await this.resolveStore(explicitHost || req.headers['x-forwarded-host'] || req.headers.host);
    const origin = getCanonicalOrigin(store);
    const override = (store as any).seo?.robotsTxtOverride?.trim();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    // Password-protected / coming-soon storefronts must not be indexed, and expose no sitemap.
    if (isLockedStore(store)) {
      res.send('User-agent: *\nDisallow: /\n');
      return;
    }
    const body = override
      ? `${override.replace(/\s*$/, '')}\nSitemap: ${origin}/sitemap.xml\n`
      : `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /cart\nDisallow: /checkout\nDisallow: /search\nDisallow: /*?*filter.\nDisallow: /*?*sort_by=\nSitemap: ${origin}/sitemap.xml\n`;
    res.send(body);
  }

  @SkipThrottle()
  @Get('sitemap.xml')
  async sitemap(@Req() req: any, @Query('host') explicitHost: string | undefined, @Res() res: Response) {
    const store = await this.resolveStore(explicitHost || req.headers['x-forwarded-host'] || req.headers.host);
    if (isLockedStore(store)) throw new NotFoundException('Sitemap not available');
    const origin = getCanonicalOrigin(store);
    const { productModel, storePageModel, blogPostModel, collectionModel, blogModel, categoryModel } = this.db.repositories;
    const storeId = String((store as any)._id);
    const [products, pages, posts, collections, blogs, categories] = await Promise.all([
      productModel.find({ storeId, status: 'active', isDelete: false }).select('slug updatedAt').lean(),
      storePageModel.find({ storeId, type: 'custom', status: 'published', isDelete: false }).select('slug updatedAt').lean(),
      blogPostModel.find({ storeId, status: 'published', isDelete: false }).select('slug blogId updatedAt').lean(),
      collectionModel.find({ storeId, status: 'active', isDelete: false }).select('slug updatedAt').lean(),
      blogModel.find({ storeId, isDelete: false }).sort({ createdAt: 1 }).select('_id slug updatedAt').lean(),
      categoryModel.find({ storeId, status: 'active', isDelete: false, slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
    ]);
    const blogSlugById = new Map(blogs.map((blog: any) => [blog._id.toString(), blog.slug]));
    const defaultBlogId = blogs[0]?._id?.toString();
    const urls = [
      { loc: `${origin}/`, lastmod: (store as any).updatedAt },
      ...(blogs[0] ? [{ loc: `${origin}/blog`, lastmod: blogs[0].updatedAt }] : []),
      ...products.map((item: any) => ({ loc: `${origin}/product/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...categories.map((item: any) => ({ loc: `${origin}/category/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...pages.map((item: any) => ({ loc: `${origin}/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...blogs.slice(1).map((blog: any) => ({ loc: `${origin}/blogs/${encodeURIComponent(blog.slug)}`, lastmod: blog.updatedAt })),
      ...posts.filter((item: any) => String(item.blogId) === defaultBlogId || !item.blogId).map((item: any) => ({ loc: `${origin}/blog/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...posts.filter((item: any) => item.blogId && blogSlugById.get(String(item.blogId)) && String(item.blogId) !== defaultBlogId).map((item: any) => ({ loc: `${origin}/blogs/${encodeURIComponent(String(blogSlugById.get(String(item.blogId))))}/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...collections.map((item: any) => ({ loc: `${origin}/collections/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
    ];
    const chunkCount = Math.max(1, Math.ceil(urls.length / MAX_URLS_PER_SITEMAP));
    let xml: string;
    if (chunkCount === 1) {
      xml = urlset(urls);
    } else {
      xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Array.from({ length: chunkCount }, (_, i) => `  <sitemap><loc>${xmlEscape(`${origin}/sitemap-${i + 1}.xml`)}</loc></sitemap>`).join('\n')}\n</sitemapindex>`;
    }
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.send(xml);
  }

  @SkipThrottle()
  @Get('sitemap-:page.xml')
  async sitemapPage(@Req() req: any, @Query('host') explicitHost: string | undefined, @Query('page') pageParam: string | undefined, @Res() res: Response) {
    const rawHost = explicitHost || req.headers['x-forwarded-host'] || req.headers.host;
    const match = String(req.path ?? '').match(/sitemap-(\d+)\.xml$/);
    const page = Number(pageParam ?? match?.[1]);
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('Invalid sitemap page');
    const store = await this.resolveStore(rawHost);
    if (isLockedStore(store)) throw new NotFoundException('Sitemap not available');
    const origin = getCanonicalOrigin(store);
    const { productModel, storePageModel, blogPostModel, collectionModel, blogModel, categoryModel } = this.db.repositories;
    const storeId = String((store as any)._id);
    const [products, pages, posts, collections, blogs, categories] = await Promise.all([
      productModel.find({ storeId, status: 'active', isDelete: false }).select('slug updatedAt').sort({ _id: 1 }).lean(),
      storePageModel.find({ storeId, type: 'custom', status: 'published', isDelete: false }).select('slug updatedAt').sort({ _id: 1 }).lean(),
      blogPostModel.find({ storeId, status: 'published', isDelete: false }).select('slug blogId updatedAt').sort({ _id: 1 }).lean(),
      collectionModel.find({ storeId, status: 'active', isDelete: false }).select('slug updatedAt').sort({ _id: 1 }).lean(),
      blogModel.find({ storeId, isDelete: false }).sort({ createdAt: 1 }).select('_id slug updatedAt').lean(),
      categoryModel.find({ storeId, status: 'active', isDelete: false, slug: { $exists: true, $ne: null } }).select('slug updatedAt').sort({ _id: 1 }).lean(),
    ]);
    const blogSlugById = new Map(blogs.map((blog: any) => [blog._id.toString(), blog.slug]));
    const defaultBlogId = blogs[0]?._id?.toString();
    const urls = [
      { loc: `${origin}/`, lastmod: (store as any).updatedAt },
      ...(blogs[0] ? [{ loc: `${origin}/blog`, lastmod: blogs[0].updatedAt }] : []),
      ...products.map((item: any) => ({ loc: `${origin}/product/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...categories.map((item: any) => ({ loc: `${origin}/category/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...pages.map((item: any) => ({ loc: `${origin}/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...blogs.slice(1).map((blog: any) => ({ loc: `${origin}/blogs/${encodeURIComponent(blog.slug)}`, lastmod: blog.updatedAt })),
      ...posts.filter((item: any) => String(item.blogId) === defaultBlogId || !item.blogId).map((item: any) => ({ loc: `${origin}/blog/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...posts.filter((item: any) => item.blogId && blogSlugById.get(String(item.blogId)) && String(item.blogId) !== defaultBlogId).map((item: any) => ({ loc: `${origin}/blogs/${encodeURIComponent(String(blogSlugById.get(String(item.blogId))))}/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...collections.map((item: any) => ({ loc: `${origin}/collections/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
    ];
    const slice = urls.slice((page - 1) * MAX_URLS_PER_SITEMAP, page * MAX_URLS_PER_SITEMAP);
    if (!slice.length) throw new NotFoundException('Sitemap chunk not found');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.send(urlset(slice));
  }

  private async resolveStore(hostValue: unknown): Promise<any> {
    const host = String(hostValue ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
    if (!host || host.length > 253) throw new BadRequestException('A valid storefront host is required');
    const { storeModel } = this.db.repositories;
    let store: any = null;
    if (host.endsWith(`.${PLATFORM_ROOT}`)) {
      const slug = host.slice(0, -(`.${PLATFORM_ROOT}`).length);
      if (slug && !slug.includes('.')) store = await storeModel.findOne({ slug, status: 'active', isDelete: false }).select('name slug primaryDomain customDomains customDomain customDomainStatus seo privacyMode updatedAt _id').lean();
    } else {
      store = await storeModel.findOne({
        $or: [
          { customDomains: { $elemMatch: { domain: host, status: 'verified' } } },
          { customDomain: host, customDomainStatus: 'verified' },
        ], status: 'active', isDelete: false,
      }).select('name slug primaryDomain customDomains customDomain customDomainStatus seo privacyMode updatedAt _id').lean();
    }
    if (!store) throw new NotFoundException('No active store is connected to this host');
    return store;
  }
}

const BUILT_IN_STOREFRONT_PATHS = new Set([
  'blog', 'cart', 'checkout', 'login', 'register', 'verify-otp', 'forgot-password', 'new-password',
  'account', 'wishlist', 'loyalty', 'messages', 'notifications', 'returns', 'gift-cards', 'store-credit',
  'orders', 'addresses', 'reviews', 'search',
]);

function normalizeRoutePath(value: string | undefined): string {
  if (!value || value === '/') return '/';
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new BadRequestException('Invalid storefront path'); }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('\0')) throw new BadRequestException('Invalid storefront path');
  return decoded.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function isBuiltInStorefrontPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 1) return BUILT_IN_STOREFRONT_PATHS.has(parts[0]);
  if (parts.length === 2 && ['orders', 'order-status', 'blog', 'blogs', 'category', 'collections', 'product'].includes(parts[0])) return true;
  if (parts.length === 3 && parts[0] === 'blogs') return true;
  if (parts.length === 3 && parts[0] === 'checkout' && parts[2] === 'return') return true;
  return false;
}

function isLockedStore(store: any): boolean {
  return store?.privacyMode === 'password' || store?.privacyMode === 'coming_soon';
}

function getCanonicalOrigin(store: any): string {
  const primary = String(store.primaryDomain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (primary && /^[a-z0-9.-]+(?::\d+)?$/.test(primary)) return `https://${primary}`;
  return `https://${store.slug}.${PLATFORM_ROOT}`;
}

function urlset(urls: Array<{ loc: string; lastmod?: Date }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((item) => `  <url><loc>${xmlEscape(item.loc)}</loc>${item.lastmod ? `<lastmod>${new Date(item.lastmod).toISOString()}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
