import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SafepayConfigStatus {
  configured: boolean;
  missing: string[];
  mode: 'sandbox' | 'live' | null;
  /** Always false until a sandbox run with Safepay's recurring documentation has happened (docs/SAFEPAY_ADAPTER.md). */
  implemented: false;
}

/**
 * Safepay recurring billing: SKELETON ONLY. It detects the SAFEPAY_* environment so the seller UI and ops can see what is
 * missing, and it never calls Safepay. The adapter stays NOT IMPLEMENTED until sandbox credentials AND Safepay's recurring
 * documentation exist; see docs/SAFEPAY_ADAPTER.md for the exact list. Pakistani stores use manual billing meanwhile.
 */
@Injectable()
export class SafepayMembershipProvider {
  readonly name = 'safepay' as const;
  readonly implemented = false as const;

  constructor(private readonly config: ConfigService) {}

  status(): SafepayConfigStatus {
    const need = ['SAFEPAY_API_KEY', 'SAFEPAY_SECRET_KEY', 'SAFEPAY_WEBHOOK_SECRET'];
    const missing = need.filter((k) => !this.config.get<string>(k));
    const env = this.config.get<string>('SAFEPAY_ENV');
    return { configured: missing.length === 0, missing, mode: env === 'live' ? 'live' : env === 'sandbox' ? 'sandbox' : null, implemented: false };
  }

  /** Why automatic billing cannot be offered through Safepay (shown to sellers as is). */
  availability(): { available: false; reason: string } {
    return { available: false, reason: 'Auto billing is not available in your country yet; use Manual billing.' };
  }
}
