/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { PosSettings } from '../pos/schemas/pos-settings.schema';
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
  constructor(@InjectModel(StoreKyb.name) private readonly model: Model<StoreKybDocument>, @Optional() @InjectModel(PosSettings.name) private readonly posSettings?: Model<any>) {}

  private async check(storeId: string): Promise<{ ok: true; subMerchantRef: string } | { ok: false; reason: string }> {
    const k: any = await this.model.findOne({ storeId }).select('status subMerchant purgedAt').lean();
    if (!k || k.status !== 'verified') return { ok: false, reason: k ? `kyb_${k.status}` : 'kyb_not_started' };
    if (!k.subMerchant?.ref) return { ok: false, reason: 'no_sub_merchant' };
    if (k.subMerchant.providerKey !== paymentsConfig().providerKey) return { ok: false, reason: 'sub_merchant_other_provider' };
    // G5.4: the owner can switch Raast off for the store (default on once verified — unchanged)
    if (this.posSettings) { const s: any = await this.posSettings.findOne({ storeId }).select('connectorPrefs').lean(); if (s?.connectorPrefs?.raastDisabled === true) return { ok: false, reason: 'disabled_by_store' }; }
    return { ok: true, subMerchantRef: k.subMerchant.ref };
  }

  async assertEnabled(storeId: string): Promise<{ subMerchantRef: string }> {
    const r = await this.check(storeId);
    if (!r.ok) throw new ForbiddenException({ statusCode: 403, code: 'STORE_NOT_VERIFIED', reason: r.reason, message: 'Digital payments are not available for this store until its business verification is approved' });
    return { subMerchantRef: r.subMerchantRef };
  }

  async isEnabled(storeId: string): Promise<boolean> { return (await this.check(storeId)).ok; }

  /** G5.4 (additive, read-only): what the Raast setup screen shows — KYB status, whether digital payments are on, why not, the provider, test mode. */
  async status(storeId: string): Promise<{ kybStatus: string; enabled: boolean; reason: string | null; providerKey: string | null; testMode: boolean; disabledByStore: boolean }> {
    const k: any = await this.model.findOne({ storeId }).select('status').lean();
    const r = await this.check(storeId);
    const providerKey = paymentsConfig().providerKey || null;
    return { kybStatus: k?.status ?? 'not_started', enabled: r.ok, reason: r.ok ? null : (r as any).reason, providerKey, testMode: providerKey === 'mock', disabledByStore: !r.ok && (r as any).reason === 'disabled_by_store' };
  }
}
