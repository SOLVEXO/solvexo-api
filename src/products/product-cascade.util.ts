/* eslint-disable prettier/prettier */
import { ClientSession } from 'mongoose';

/**
 * Everything that must change when products are removed from a store, in ONE place so single delete, bulk delete and any
 * future caller behave identically. Runs inside the caller's transaction (`session`).
 *
 *  - the product + its variants are soft-deleted (history/orders keep their own snapshots), so the variants' SKUs are released;
 *  - open carts lose the lines (otherwise the buyer sees an item that can no longer be bought);
 *  - collections stop listing them (manual collections hold product ids);
 *  - wishlists drop them (hard delete — those rows have no soft-delete flag).
 *
 * Orders, returns, analytics and purchase orders are deliberately untouched: they reference a product by id and keep their
 * own name/price snapshot.
 */
export interface CatalogRepos {
  productModel: any;
  productVariantModel: any;
  cartModel: any;
  collectionModel: any;
  wishListModel: any;
}

export async function softDeleteProducts(
  r: CatalogRepos,
  args: { storeId: string; productIds: string[]; session?: ClientSession },
): Promise<{ products: number; variants: number }> {
  const { storeId, productIds, session } = args;
  if (productIds.length === 0) return { products: 0, variants: 0 };

  const products = await r.productModel.updateMany(
    { _id: { $in: productIds }, storeId, isDelete: false },
    { $set: { isDelete: true, status: 'inactive' } },
    { session },
  );
  const variants = await r.productVariantModel.updateMany(
    { productId: { $in: productIds }, isDelete: false },
    { $set: { isDelete: true, isDefault: false } },
    { session },
  );
  await r.cartModel.updateMany(
    { storeId, 'items.productId': { $in: productIds } },
    { $pull: { items: { productId: { $in: productIds } } } },
    { session },
  );
  await r.collectionModel.updateMany(
    { storeId, productIds: { $in: productIds } },
    { $pull: { productIds: { $in: productIds } } },
    { session },
  );
  // wishlist rows carry no soft-delete flag — a wished product that no longer exists is simply removed
  await r.wishListModel.deleteMany({ storeId, productId: { $in: productIds } }, { session });
  return { products: products?.modifiedCount ?? 0, variants: variants?.modifiedCount ?? 0 };
}
