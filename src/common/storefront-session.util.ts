/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';

/**
 * Server-side funnel steps for online-store analytics (Shopify: added to cart -> reached checkout -> converted).
 * The storefront sends its current visit id as `analyticsSessionId` in the add-to-cart / create-checkout body (a
 * body field, not a custom header, so no CORS change is needed); the step is recorded only when the real cart /
 * checkout / order write succeeds, so a client can't fabricate a conversion.
 */

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isAnalyticsId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** The visit id the storefront sent in the request body, or null when absent/malformed. */
export function readAnalyticsSessionId(body: { analyticsSessionId?: unknown } | null | undefined): string | null {
  const value = body?.analyticsSessionId;
  return isAnalyticsId(value) ? value : null;
}

export interface SessionFunnelPatch {
  addedToCart?: true;
  reachedCheckout?: true;
  converted?: true;
  orderIds?: string[];
  userId?: string | null;
}

/**
 * Marks a funnel step on an EXISTING visit of this store (a page view created it). Never creates a session and
 * never throws — analytics must not break a cart/checkout/order write.
 */
export async function markStorefrontSession(
  sessionModel: Model<any> | undefined,
  storeId: string | null | undefined,
  sessionId: string | null | undefined,
  patch: SessionFunnelPatch,
): Promise<void> {
  if (!sessionModel || !storeId || !isAnalyticsId(sessionId)) return;
  const $set: Record<string, any> = { lastSeenAt: new Date() };
  if (patch.addedToCart) $set.addedToCart = true;
  if (patch.reachedCheckout) { $set.reachedCheckout = true; $set.addedToCart = true; }
  if (patch.converted) { $set.converted = true; $set.reachedCheckout = true; $set.addedToCart = true; }
  if (patch.userId) $set.userId = patch.userId;
  const update: Record<string, any> = { $set };
  if (patch.orderIds?.length) update.$addToSet = { orderIds: { $each: patch.orderIds } };
  try {
    await sessionModel.updateOne({ storeId: String(storeId), sessionId }, update);
  } catch {
    // best-effort
  }
}
