/* eslint-disable prettier/prettier */
import { decryptCredential } from '../common/credential-encryption.util';
import { DecryptedPaymentConfig } from './interfaces/payment-provider.interface';
import { StoreIntegrationDocument } from './schemas/store-integration.schema';

/**
 * Decrypts a `StoreIntegration` document's credential blob into the shape
 * every `PaymentProvider` implementation expects. Returns an empty
 * `credentials` object for providers (Stripe) that never store one — see
 * `StripePaymentProvider`'s class doc for why.
 */
export function toDecryptedPaymentConfig(integration: StoreIntegrationDocument): DecryptedPaymentConfig {
  const credentials = integration.credentialsEncrypted
    ? JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS'))
    : {};
  return {
    credentials,
    config: integration.config ?? {},
    mode: integration.mode,
    webhookToken: integration.webhookToken,
  };
}
