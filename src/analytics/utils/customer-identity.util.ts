/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';

/**
 * Shared buyer-identity resolution for every analytics surface that lists
 * customers by `Order.userId` (owner Analytics, seller Analytics, and both
 * of their CSV exports — 4 call sites as of this writing, all previously
 * carrying their own copy-pasted `?? 'Unknown'` fallback).
 *
 * There is no guest-checkout path anywhere in this codebase — every
 * `createCheckout` call is behind `JwtAuthGuard` (see
 * `checkout/checkout.controller.ts`) — so a `userId` that no longer matches
 * a `User` document never means "guest"; it means the buyer's account was
 * deleted after they ordered. Resolution order:
 *   1. Live `User` document — real name + email.
 *   2. `Order.shippingAddress.recipientName` — the name captured on the
 *      order itself at purchase time, independent of the live User
 *      collection. No email fallback exists anywhere else in the schema.
 *   3. `'Deleted account'` — never `'Guest'`.
 */
export interface CustomerIdentity {
  name: string;
  email: string;
}

export async function resolveCustomerIdentities(
  userModel: Model<any>,
  orderModel: Model<any>,
  userIds: string[],
): Promise<Map<string, CustomerIdentity>> {
  const uniqueIds = [...new Set(userIds)];
  const result = new Map<string, CustomerIdentity>();
  if (uniqueIds.length === 0) return result;

  const users = await userModel.find({ _id: { $in: uniqueIds } }).select('name email').lean();
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

  const unresolvedIds = uniqueIds.filter((id) => !userMap.has(id));
  const fallbackNameMap = new Map<string, string>();
  if (unresolvedIds.length > 0) {
    const fallbackRows = await orderModel.aggregate([
      { $match: { isDelete: false, userId: { $in: unresolvedIds }, shippingAddress: { $ne: null } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$userId', recipientName: { $first: '$shippingAddress.recipientName' } } },
    ]);
    for (const r of fallbackRows) fallbackNameMap.set(r._id, r.recipientName);
  }

  for (const id of uniqueIds) {
    const user: any = userMap.get(id);
    result.set(id, {
      name: user?.name ?? fallbackNameMap.get(id) ?? 'Deleted account',
      email: user?.email ?? '',
    });
  }
  return result;
}

/**
 * Label for a `shippingAddress.state`/`.country` group-by `_id` that came back
 * null/empty. `country` in particular was added to the schema after `state`
 * (see `OrderShippingAddress`'s own doc comment) — an order placed before that
 * genuinely has no country captured. This is a real historical data gap, not a
 * failed lookup, so it is never worth guessing (e.g. inferring country from
 * state) to paper over it.
 */
export const NOT_RECORDED_LABEL = 'Not Recorded';
