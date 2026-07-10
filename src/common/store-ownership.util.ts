/* eslint-disable prettier/prettier */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Model } from 'mongoose';

/**
 * Shared store-ownership checks — this exact pattern was previously copy-pasted
 * across `FinanceService`, seller `AnalyticsService`, and referenced in a comment
 * in `SubscriptionsService`. Two distinct behaviors already existed in production
 * and are preserved here verbatim (not unified into one) to avoid changing any
 * existing endpoint's response codes:
 *
 * - `verifyStoreOwnershipOrForbidden` — single query, collapses "doesn't exist" and
 *   "wrong owner" into one 403 (what seller Analytics already does).
 * - `verifyStoreOwnershipStrict` — two checks, 404 for a missing/deleted store vs
 *   403 for a real store owned by someone else (what Finance already does).
 * - `verifyStoreExists` — existence-only, no seller comparison — for admin-facing
 *   code that's allowed to act on any store.
 */

export async function verifyStoreOwnershipOrForbidden(storeModel: Model<any>, storeId: string, sellerId: string) {
  const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
  if (!store) throw new ForbiddenException('Store not found or unauthorized');
  return store;
}

export async function verifyStoreOwnershipStrict(storeModel: Model<any>, storeId: string, sellerId: string) {
  const store = await storeModel.findById(storeId);
  if (!store || store.isDelete) throw new NotFoundException('Store not found');
  if (store.sellerId.toString() !== sellerId) throw new ForbiddenException('Access denied');
  return store;
}

export async function verifyStoreExists(storeModel: Model<any>, storeId: string) {
  const store = await storeModel.findById(storeId);
  if (!store || store.isDelete) throw new NotFoundException('Store not found');
  return store;
}
