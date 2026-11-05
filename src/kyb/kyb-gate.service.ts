/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DigitalPaymentsGate } from '../payments-core/digital-payments-gate';
import { paymentsConfig } from '../payments-core/payments-config';
import { StoreKyb, StoreKybDocument } from './kyb.schemas';

/**
 * digitalPaymentsEnabled(store) = KYB `verified` AND a sub-merchant reference at the ACTIVE provider. (The POS plan being active is
 * enforced separately by `PosEntitlementGuard` on the routes that sell.) A revoked KYB stops digital payments immediately — the status
 * is read on every call, nothing is cached.
 */
@Injectable()
export class KybGateService implements DigitalPaymentsGate {
  constructor(@InjectModel(StoreKyb.name) private readonly model: Model<StoreKybDocument>) {}

  private async check(storeId: string): Promise<{ ok: true; subMerchantRef: string } | { ok: false; reason: string }> {
    const k: any = await this.model.findOne({ storeId }).select('status subMerchant purgedAt').lean();
    if (!k || k.status !== 'verified') return { ok: false, reason: k ? `kyb_${k.status}` : 'kyb_not_started' };
    if (!k.subMerchant?.ref) return { ok: false, reason: 'no_sub_merchant' };
    if (k.subMerchant.providerKey !== paymentsConfig().providerKey) return { ok: false, reason: 'sub_merchant_other_provider' };
    return { ok: true, subMerchantRef: k.subMerchant.ref };
  }

  async assertEnabled(storeId: string): Promise<{ subMerchantRef: string }> {
    const r = await this.check(storeId);
    if (!r.ok) throw new ForbiddenException({ statusCode: 403, code: 'STORE_NOT_VERIFIED', reason: r.reason, message: 'Digital payments are not available for this store until its business verification is approved' });
    return { subMerchantRef: r.subMerchantRef };
  }

  async isEnabled(storeId: string): Promise<boolean> { return (await this.check(storeId)).ok; }
}
