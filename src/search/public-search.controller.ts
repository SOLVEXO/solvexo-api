/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';

const MIN_QUERY = 2;
const MAX_QUERY = 100;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shopify Predictive Search equivalent — lightweight, store-scoped, public.
 *  `suggest` powers the header dropdown (a few of each resource); `content`
 *  powers the Articles / Pages tabs on the search results page. Only ACTIVE
 *  products, active collections, published pages and published posts are
 *  returned; password / coming-soon stores are blocked before reaching here by
 *  the global storefront-access middleware (see RULES in
 *  store/storefront-access.service.ts). */
@Controller('api/public/search')
export class PublicSearchController {
  constructor(private readonly db: DatabaseService) {}

  private async activeStore(storeId: string) {
    if (!storeId || typeof storeId !== 'string') throw new BadRequestException('storeId is required');
    let store: any = null;
    try {
      store = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false, status: 'active' }).select('_id').lean();
    } catch {
      /* invalid id */
    }
    if (!store) throw new BadRequestException('Store not found');
  }

  private cleanQuery(q: unknown): string {
    return String(typeof q === 'string' ? q : '').trim().slice(0, MAX_QUERY);
  }

  private async contentMatches(storeId: string, rx: RegExp, limit: number, skip = 0) {
    const { storePageModel, blogPostModel } = this.db.repositories;
    const [articles, pages, articleTotal, pageTotal] = await Promise.all([
      blogPostModel.find({ storeId, status: 'published', isDelete: false, $or: [{ title: rx }, { excerpt: rx }] })
        .select('title slug excerpt coverImage').sort({ publishedAt: -1 }).skip(skip).limit(limit).lean(),
      storePageModel.find({ storeId, type: 'custom', status: 'published', isDelete: false, title: rx })
        .select('title slug').sort({ title: 1 }).skip(skip).limit(limit).lean(),
      blogPostModel.countDocuments({ storeId, status: 'published', isDelete: false, $or: [{ title: rx }, { excerpt: rx }] }),
      storePageModel.countDocuments({ storeId, type: 'custom', status: 'published', isDelete: false, title: rx }),
    ]);
    return {
      articles: (articles as any[]).map((a) => ({ id: String(a._id), title: a.title, slug: a.slug, excerpt: (a.excerpt ?? '').slice(0, 160), image: a.coverImage ?? null })),
      pages: (pages as any[]).map((p) => ({ id: String(p._id), title: p.title, slug: p.slug })),
      totals: { articles: articleTotal, pages: pageTotal },
    };
  }

  @Get('suggest')
  async suggest(@Query('storeId') storeId: string, @Query('q') qRaw: string, @Query('limit') limitRaw?: string) {
    await this.activeStore(storeId);
    const q = this.cleanQuery(qRaw);
    if (q.length < MIN_QUERY) return { success: true, data: { query: q, products: [], collections: [], articles: [], pages: [], queries: [] } };
    const limit = Math.min(10, Math.max(1, parseInt(limitRaw as string) || 4));
    const rx = new RegExp(escapeRegex(q), 'i');
    const { productModel, productVariantModel, collectionModel } = this.db.repositories;

    const [products, collections, content, tagRows] = await Promise.all([
      productModel.find({ storeId, isDelete: false, status: 'active', name: rx }).select('name slug images').sort({ createdAt: -1 }).limit(limit).lean(),
      collectionModel.find({ storeId, isDelete: false, status: 'active', name: rx }).select('name slug image').limit(limit).lean(),
      this.contentMatches(storeId, rx, limit),
      productModel.aggregate([
        { $match: { storeId, isDelete: false, status: 'active', $or: [{ name: rx }, { tags: rx }] } },
        { $project: { name: 1, tags: 1 } },
        { $limit: 200 },
      ]),
    ]);

    const productIds = (products as any[]).map((p) => String(p._id));
    const variants: any[] = productIds.length
      ? await productVariantModel.find({ productId: { $in: productIds }, status: 'active', isDelete: false }).select('productId price compareAtPrice').sort({ price: 1 }).lean()
      : [];
    const cheapest = new Map<string, any>();
    for (const v of variants) if (!cheapest.has(v.productId)) cheapest.set(v.productId, v);

    // Query suggestions: matching tags + the title words/phrases that start with what was typed.
    const lower = q.toLowerCase();
    const queries = new Set<string>();
    for (const row of tagRows as any[]) {
      for (const t of row.tags ?? []) if (String(t).toLowerCase().includes(lower)) queries.add(String(t).toLowerCase());
      const name = String(row.name ?? '').toLowerCase();
      const at = name.indexOf(lower);
      if (at >= 0) {
        const tail = name.slice(at).split(/\s+/).slice(0, 3).join(' ').replace(/[^\p{L}\p{N}\s-]/gu, '').trim();
        if (tail) queries.add(tail);
      }
      if (queries.size >= 12) break;
    }
    queries.delete(lower);

    return {
      success: true,
      data: {
        query: q,
        products: (products as any[]).map((p) => {
          const v = cheapest.get(String(p._id));
          return {
            id: String(p._id), name: p.name, slug: p.slug, image: p.images?.[0] ?? null,
            price: v?.price ?? null, compareAtPrice: v?.compareAtPrice ?? null,
          };
        }),
        collections: (collections as any[]).map((c) => ({ id: String(c._id), name: c.name, slug: c.slug, image: c.image ?? null })),
        articles: content.articles,
        pages: content.pages,
        queries: [...queries].slice(0, 5),
      },
    };
  }

  @Get('content')
  async content(@Query('storeId') storeId: string, @Query('q') qRaw: string, @Query('page') pageRaw?: string, @Query('limit') limitRaw?: string) {
    await this.activeStore(storeId);
    const q = this.cleanQuery(qRaw);
    if (!q) return { success: true, data: { articles: [], pages: [], totals: { articles: 0, pages: 0 } } };
    const limit = Math.min(30, Math.max(1, parseInt(limitRaw as string) || 12));
    const page = Math.max(1, parseInt(pageRaw as string) || 1);
    const data = await this.contentMatches(storeId, new RegExp(escapeRegex(q), 'i'), limit, (page - 1) * limit);
    return { success: true, data: { ...data, page, limit } };
  }
}
