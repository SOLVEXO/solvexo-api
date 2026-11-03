/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

export type PosLimitKind = 'registers' | 'employees' | 'locations';
const FIELD: Record<PosLimitKind, string> = { registers: 'maxRegisters', employees: 'maxEmployees', locations: 'maxLocations' };

/**
 * Optional per-plan caps (PosPlan.maxRegisters / maxEmployees / maxLocations; null = unlimited). Applies only while the store
 * has an ACTIVE plan that names a real PosPlan (manual grants without a plan, lapsed plans and stores with no plan are not
 * limited here — selling itself is gated by PosEntitlementGuard). Throws 400 POS_PLAN_LIMIT when adding one more would exceed it.
 */
export async function assertWithinPosPlanLimit(
  repos: { posPurchaseModel: any; posPlanModel: any },
  storeId: string,
  kind: PosLimitKind,
  currentCount: number,
): Promise<void> {
  const purchase: any = await repos.posPurchaseModel.findOne({ storeId }).sort({ purchasedAt: -1 }).lean();
  if (!purchase || new Date(purchase.expiresAt).getTime() <= Date.now() || !/^[a-f0-9]{24}$/i.test(String(purchase.planId))) return;
  const plan: any = await repos.posPlanModel.findById(purchase.planId).lean();
  const max = plan?.[FIELD[kind]];
  if (typeof max === 'number' && currentCount >= max) {
    throw new BadRequestException({ statusCode: 400, code: 'POS_PLAN_LIMIT', message: `Your POS plan allows ${max} ${kind}. Remove one or move to a bigger plan.`, limit: max, kind });
  }
}
