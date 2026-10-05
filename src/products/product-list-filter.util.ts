/* eslint-disable prettier/prettier */

export const PRODUCT_STATUSES = ['active', 'inactive', 'draft', 'scheduled'] as const;

/** Escapes user text for use inside a RegExp. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ONE place the seller's product list (and the bulk-actions "select every matching product") builds its Mongo
 * filter, so what the seller sees filtered is exactly what a bulk action applies to.
 * Supports status / type / free-text search (title, tags, or any variant's SKU or barcode), all server-side.
 */
export async function buildStoreProductFilter(
  repos: { productVariantModel: any },
  storeId: string,
  sellerId: string,
  query: { status?: string; type?: string; q?: string },
): Promise<Record<string, any>> {
  const filter: Record<string, any> = { storeId, sellerId, isDelete: false };
  if (query.type && query.type !== 'all') filter.type = String(query.type);
  if (query.status && query.status !== 'all') filter.status = String(query.status);

  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    const variantHits: any[] = await repos.productVariantModel
      .find({ isDelete: false, $or: [{ sku: re }, { barcode: re }] })
      .select('productId')
      .limit(500)
      .lean();
    filter.$or = [
      { name: re },
      { tags: re },
      ...(variantHits.length ? [{ _id: { $in: [...new Set(variantHits.map((v) => String(v.productId)))] } }] : []),
    ];
  }
  return filter;
}

/** Shopify-style product-list sorts. */
export function productSort(sort?: string): Record<string, 1 | -1> {
  switch (sort) {
    case 'oldest': return { createdAt: 1 };
    case 'title_asc': return { name: 1 };
    case 'title_desc': return { name: -1 };
    default: return { createdAt: -1 };
  }
}
