/* eslint-disable prettier/prettier */
import { Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { KybGateService } from '@/kyb/kyb-gate.service';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { CONNECTOR_DEFAULTS } from './pos-store-settings.service';
import { cardGatewayFor, CARD_GATEWAY_NEEDS } from './connectors/card-gateway';
import { fiscalProviderFor } from './connectors/fiscal';
import { RAAST_PROVIDER_NEEDS } from './connectors/raast-adapters';

type Req = { user: { userId: string; role?: string; posDevice?: any } };

/**
 * G5.4 / G5.7 — one read of every provider-dependent feature for the till's Payments / Integrations screens: the store's switches (all OFF by default),
 * which provider the server has (mock / not configured / none) and whether it is in test mode. Switches are changed through store settings
 * (`connectors` section, owner only, audited). Read-only; nothing secret is returned.
 */
@Injectable()
export class PosConnectorsService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer, @Optional() private readonly kyb?: KybGateService) {}
  private get r(): any { return this.db.repositories; }

  async status(req: Req, storeId: string, t: { employee?: string }) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    await this.auth.authorize(req as any, { storeId, action: 'sales.reprint', employeeToken: t.employee });
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('connectorPrefs').lean();
    const flags = { ...CONNECTOR_DEFAULTS, ...(s?.connectorPrefs ?? {}) };
    const provider = (p: { key: string; testMode: boolean } | null) => (p ? { provider: p.key, testMode: p.testMode, configured: p.key === 'mock' } : { provider: null, testMode: false, configured: false });
    const raast = this.kyb ? await this.kyb.status(storeId) : null;
    return {
      success: true,
      data: {
        flags,
        cardGateway: { ...provider(cardGatewayFor()), needs: Object.keys(CARD_GATEWAY_NEEDS ?? {}) },
        fiscal: provider(fiscalProviderFor()),
        raast: raast ? { ...raast, adaptersPending: Object.keys(RAAST_PROVIDER_NEEDS ?? {}) } : null,
        ui: connectorUi({ raastProvider: raast?.providerKey ?? null, raastReason: raast?.reason ?? null, cardGateway: cardGatewayFor() }),
      },
    };
  }
}

/**
 * G6.1 — what the till shows for each provider-dependent feature, decided HERE so a real provider (or new wording, fields, rules) needs no app
 * update. The app falls back to these same values when the field is absent (an older backend). Nothing secret; no provider credential.
 */
export function connectorUi(a: { raastProvider: string | null; raastReason: string | null; cardGateway: { key: string; testMode: boolean } | null }, env: NodeJS.ProcessEnv = process.env) {
  const raastReasonText: Record<string, string> = {
    no_sub_merchant: 'Raast is being set up for your store by the payment provider. You will be able to take Raast payments once that is done.',
    disabled_by_store: 'Raast is switched off for this store (Payments setup).',
    sub_merchant_other_provider: 'Raast is being moved to a new payment provider for your store. It will be available again once that is done.',
  };
  const reasonText = (r: string | null) => (!r ? null : r.startsWith('kyb_') ? 'Verify your business (Payments setup) to take Raast payments.' : raastReasonText[r] ?? null);
  return {
    raast: {
      displayName: 'Raast QR',
      customerInstructions: 'Customer: open your bank app, choose Raast and scan.',
      pollAfterMs: 2000,
      // the "simulate paid" button exists only for the mock provider outside production
      simulateAvailable: a.raastProvider === 'mock' && env.NODE_ENV !== 'production',
      reasonText: reasonText(a.raastReason),
    },
    cardExternalTerminal: {
      label: 'Card on a bank terminal',
      fields: [
        { key: 'approvalCode', label: 'Approval code', required: true, pattern: null, maxLength: 32, keyboard: 'text' },
        { key: 'last4', label: 'Last 4', required: false, pattern: '^\\d{4}$', maxLength: 4, keyboard: 'number' },
        { key: 'terminalLabel', label: 'Terminal', required: false, pattern: null, maxLength: 40, keyboard: 'text' },
      ],
    },
    cardGateway: {
      statusText: a.cardGateway && a.cardGateway.key !== 'mock' ? null : 'Not available yet. Solvexo is choosing a card provider; until then, use a bank terminal.',
    },
    receipts: {
      whatsapp: { mode: 'link' as 'link' | 'api' | 'off' },
      minPhoneDigits: 10,
      consentText: 'The customer gave this contact for their receipt',
      privacyNote: 'Only the store name, the total and the receipt link are sent.',
    },
  };
}
