/* eslint-disable prettier/prettier */

/**
 * Shopify counts ONE customer per email, whether they checked out as a guest (even several times) or with an account.
 * Access control stays on `Order.userId` (a guest session only ever sees its own session's orders), so the stable
 * identity used for customer counting / lists lives separately in `Order.customerId`:
 *  - a real account → its own id;
 *  - a guest with a contact email → the account of the same email in that store if one exists, else the earliest guest row
 *    that used that email (so repeat guest purchases collapse into one customer);
 *  - a guest without a contact email → the session's own row.
 */
export async function resolveCustomerId(
  repos: { userModel: any },
  userId: string,
): Promise<string> {
  try {
    const u: any = await repos.userModel.findById(userId).select('storeId email contactEmail isGuest').lean();
    if (!u || !u.isGuest || !u.contactEmail) return String(userId);
    const email = String(u.contactEmail).toLowerCase();
    const account: any = await repos.userModel
      .findOne({ storeId: u.storeId, email, isGuest: { $ne: true }, isDelete: { $ne: true } })
      .select('_id').lean();
    if (account) return String(account._id);
    const firstGuest: any = await repos.userModel
      .findOne({ storeId: u.storeId, isGuest: true, contactEmail: email })
      .sort({ createdAt: 1 }).select('_id').lean();
    return String(firstGuest?._id ?? userId);
  } catch {
    return String(userId); // identity is an analytics nicety — never block an order on it
  }
}
