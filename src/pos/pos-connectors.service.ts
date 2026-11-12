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
      },
    };
  }
}
