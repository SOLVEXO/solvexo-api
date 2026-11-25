/* eslint-disable prettier/prettier */
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

/**
 * G6.2 — what this backend can do, for the till's feature detection. The app probes this ONE route on every start, after re-login and after a
 * store switch: the answer (or this route being absent, as on the G5.1 backend) decides which features it shows — never an ordinary 404 of some
 * resource. Static, no store or user data, no parameters (so it can never answer "resource not found"). Public and throttled.
 * Add a feature key here when a new till feature needs a backend that has it; never remove one while older apps may rely on it.
 */
export const POS_CAPABILITIES = {
  contract: 1,
  /** backend release of the POS work (1 = G1–G5.1 on main at c889af0; 2 = G5.2 onward) */
  release: 2,
  features: [
    'productPage', // G5.2 product page + edit
    'receiptDelivery', // G5.3 e-mail / SMS receipts
    'connectors', // G5.4 connectors read + Payments setup
    'cardExternalTerminal', // G5.4
    'fiscal', // G5.5 fiscal block
    'receiptLogo', // G5.6
    'rolePresets', // G5.6
    'integrations', // G5.7 Integrations screen, accounting export
    'apiKeys', // G5.7
    'fiscalContract', // G6.1 contract v1 (display lines, message, willRetry, logo)
    'fiscalIssues', // G6.1 issues + owner retry
    'connectorUi', // G6.1 connectors.ui
  ],
} as const;

@ApiTags('POS capabilities')
@Controller('api/pos/capabilities')
export class PosCapabilitiesController {
  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  capabilities() {
    return { success: true, data: POS_CAPABILITIES };
  }
}
