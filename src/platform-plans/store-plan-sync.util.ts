/* eslint-disable prettier/prettier */
/**
 * `Store.plan` is a DENORMALISED CACHE of the store's plan (the legacy platform-subscriptions system used
 * to write it). The source of truth is `SellerPlatformSubscription` -> `PlatformPlan`. This keeps the cache
 * aligned whenever a subscription document is saved (activate, upgrade, downgrade, cancel, trial end,
 * lock/suspend, admin assign...) — see the `post('save')` hook in seller-platform-subscription.schema.ts.
 * Entitlements/limits never read it; only `StoreService` uses it as a display fallback.
 */
export const STORE_PLAN_CACHE_VALUES = ['starter', 'basic', 'grow', 'advanced', 'pro', 'enterprise'] as const;

/** Pure mapping: which `Store.plan` value represents this subscription. Returns null = leave unchanged. */
export function resolveStorePlanCacheValue(
  sub: { platformPlanId?: string | null; status?: string | null } | null | undefined,
  plan: { key?: string | null; name?: string | null; isFree?: boolean } | null | undefined,
): string | null {
  if (!sub) return null;
  // Trialing (no plan attached) or cancelled: the store is not on a paid plan -> starter (free tier).
  if (!sub.platformPlanId || sub.status === 'canceled') return 'starter';
  if (!plan) return null; // plan doc missing/deleted — don't guess
  if (plan.isFree) return 'starter';
  const candidate = (plan.key || plan.name || '').toString().trim().toLowerCase();
  return (STORE_PLAN_CACHE_VALUES as readonly string[]).includes(candidate) ? candidate : null;
}

/** Idempotent (conditional update, no-op when already equal). Never throws — a cache write must not fail billing. */
export async function syncStorePlanCache(
  models: { storeModel: any; planModel: any },
  sub: any,
  session?: any,
): Promise<boolean> {
  try {
    if (!sub || sub.isDelete || !sub.storeId) return false;
    let plan: any = null;
    if (sub.platformPlanId) plan = await models.planModel.findById(sub.platformPlanId).select('key name isFree').lean();
    const target = resolveStorePlanCacheValue(sub, plan);
    if (!target) return false;
    const q = models.storeModel.updateOne({ _id: sub.storeId, plan: { $ne: target } }, { $set: { plan: target } });
    if (session) q.session(session);
    const r: any = await q;
    return (r?.modifiedCount ?? 0) > 0;
  } catch {
    return false;
  }
}
