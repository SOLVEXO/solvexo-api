/* eslint-disable prettier/prettier */

/**
 * The ONE definition of "a customer of this store" for *searching* (attaching a customer to a POS sale or a
 * draft order). A user qualifies only if they relate to THIS store: they placed an order that includes it, were
 * attached to one of its POS sales, or were added/tagged as its customer by the seller. Everyone else on the
 * platform is invisible — searching the whole `users` collection would let any seller enumerate other stores'
 * buyers by name/email/phone.
 *
 * Same sources the store's own customer list uses (StoreService.storeCustomerIdsFromOrders + storeCustomerMeta),
 * plus POS-sale customers.
 */
type Repos = { orderModel: any; saleModel: any; storeCustomerMetaModel: any; userModel: any };

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export async function storeCustomerUserIds(r: Repos, storeId: string): Promise<string[]> {
  const [orderRows, posCustomerIds, metaIds] = await Promise.all([
    r.orderModel.aggregate([
      { $match: { 'sellerOrders.storeId': storeId, isDelete: false } },
      { $group: { _id: { $ifNull: ['$customerId', '$userId'] } } },
    ]),
    r.saleModel.distinct('customerId', { storeId, customerId: { $ne: null } }),
    r.storeCustomerMetaModel.distinct('userId', { storeId }),
  ]);
  const ids = new Set<string>();
  for (const row of orderRows) ids.add(String(row._id));
  for (const id of posCustomerIds) ids.add(String(id));
  for (const id of metaIds) ids.add(String(id));
  return [...ids].filter((id) => OBJECT_ID.test(id));
}

export async function searchStoreCustomers(
  r: Repos,
  storeId: string,
  term: string,
  limit = 10,
): Promise<Array<{ id: string; name: string; email: string; phone: string }>> {
  const trimmed = (term ?? '').trim();
  if (!trimmed) return [];
  const ids = await storeCustomerUserIds(r, storeId);
  if (!ids.length) return [];
  const re = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const users = await r.userModel
    .find({ _id: { $in: ids }, $or: [{ name: re }, { email: re }, { phone: re }] })
    .select('name email phone')
    .limit(limit)
    .lean();
  return users.map((u: any) => ({ id: u._id.toString(), name: u.name, email: u.email, phone: u.phone }));
}
