/* eslint-disable prettier/prettier */
import { Controller, Get, Query, Req, Res, NotFoundException, BadRequestException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { DatabaseService } from '@/database/databaseservice';

const PLATFORM_ROOT = 'solvexo.store';
const MAX_URLS_PER_SITEMAP = 45_000;

/** Host-routed crawl files for each live merchant storefront. The Vercel
 * storefront edge forwards /robots.txt and /sitemap*.xml here while keeping
 * the original host in X-Forwarded-Host. */
@Controller('api/storefront-seo')
export class StorefrontSeoController {
  constructor(private readonly db: DatabaseService) {}

  @SkipThrottle()
  @Get('robots.txt')
  async robots(@Req() req: any, @Query('host') explicitHost: string | undefined, @Res() res: Response) {
    const store = await this.resolveStore(explicitHost || req.headers['x-forwarded-host'] || req.headers.host);
    const origin = getCanonicalOrigin(store);
    const override = (store as any).seo?.robotsTxtOverride?.trim();
    const body = override
      ? `${override.replace(/\s*$/, '')}\nSitemap: ${origin}/sitemap.xml\n`
      : `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /cart\nDisallow: /checkout\nSitemap: ${origin}/sitemap.xml\n`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.send(body);
  }

  @SkipThrottle()
  @Get('sitemap.xml')
  async sitemap(@Req() req: any, @Query('host') explicitHost: string | undefined, @Res() res: Response) {
    const store = await this.resolveStore(explicitHost || req.headers['x-forwarded-host'] || req.headers.host);
    const origin = getCanonicalOrigin(store);
    const { productModel, storePageModel, blogPostModel } = this.db.repositories;
    const storeId = String((store as any)._id);
    const [products, pages, posts] = await Promise.all([
      productModel.find({ storeId, status: 'active', isDelete: false }).select('slug updatedAt').lean(),
      storePageModel.find({ storeId, type: 'custom', status: 'published', isDelete: false }).select('slug updatedAt').lean(),
      blogPostModel.find({ storeId, status: 'published', isDelete: false }).select('slug updatedAt').lean(),
    ]);
    const urls = [
      { loc: `${origin}/`, lastmod: (store as any).updatedAt },
      ...products.map((item: any) => ({ loc: `${origin}/product/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...pages.map((item: any) => ({ loc: `${origin}/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...posts.map((item: any) => ({ loc: `${origin}/blog/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
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
    const origin = getCanonicalOrigin(store);
    const { productModel, storePageModel, blogPostModel } = this.db.repositories;
    const storeId = String((store as any)._id);
    const [products, pages, posts] = await Promise.all([
      productModel.find({ storeId, status: 'active', isDelete: false }).select('slug updatedAt').sort({ _id: 1 }).lean(),
      storePageModel.find({ storeId, type: 'custom', status: 'published', isDelete: false }).select('slug updatedAt').sort({ _id: 1 }).lean(),
      blogPostModel.find({ storeId, status: 'published', isDelete: false }).select('slug updatedAt').sort({ _id: 1 }).lean(),
    ]);
    const urls = [
      { loc: `${origin}/`, lastmod: (store as any).updatedAt },
      ...products.map((item: any) => ({ loc: `${origin}/product/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...pages.map((item: any) => ({ loc: `${origin}/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
      ...posts.map((item: any) => ({ loc: `${origin}/blog/${encodeURIComponent(item.slug)}`, lastmod: item.updatedAt })),
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
      if (slug && !slug.includes('.')) store = await storeModel.findOne({ slug, status: 'active', isDelete: false }).select('name slug primaryDomain customDomains customDomain customDomainStatus seo updatedAt _id').lean();
    } else {
      store = await storeModel.findOne({
        $or: [
          { customDomains: { $elemMatch: { domain: host, status: 'verified' } } },
          { customDomain: host, customDomainStatus: 'verified' },
        ], status: 'active', isDelete: false,
      }).select('name slug primaryDomain customDomains customDomain customDomainStatus seo updatedAt _id').lean();
    }
    if (!store) throw new NotFoundException('No active store is connected to this host');
    return store;
  }
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
