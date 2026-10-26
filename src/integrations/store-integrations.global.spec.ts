/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { StoreIntegrationsService } from './store-integrations.service';
import { DatabaseService } from '../database/databaseservice';
import { decryptCredential } from '../common/credential-encryption.util';
import { GENERIC_GATEWAY_KEYS } from './payment-provider-catalog';

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';

function build(storeOverrides: Record<string, any> = {}, integrations: any[] = []) {
  const store = { _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, baseCurrency: 'EUR', country: 'DE', ...storeOverrides };
  const storeModel = { findById: jest.fn().mockResolvedValue(store), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) };
  const storeIntegrationModel: any = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue(integrations),
    findOneAndUpdate: jest.fn().mockImplementation((_f: any, update: any) => Promise.resolve({ _id: 'int-1', type: 'payment', provider: _f.provider, ...update.$set, webhookToken: update.$setOnInsert?.webhookToken, config: {} })),
  };
  const manualPaymentMethodModel = { find: jest.fn().mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([]) }) }) };
  const db = { repositories: { storeModel, storeIntegrationModel, manualPaymentMethodModel } } as unknown as DatabaseService;
  const registry: any = { isSupported: jest.fn().mockReturnValue(true) };
  const stripeConnect: any = {
    getStatus: jest.fn().mockResolvedValue({ data: { connected: false, chargesEnabled: false, payoutsEnabled: false } }),
    isTestMode: jest.fn().mockReturnValue(true),
  };
  const service = new StoreIntegrationsService(db, { log: jest.fn() } as any, registry, {} as any, stripeConnect, {} as any, {} as any);
  return { service, storeIntegrationModel, registry };
}

describe('StoreIntegrationsService — global gateways with the seller\'s own keys', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  describe('connect', () => {
    it('connects Mollie from the one catalog form: encrypts the key, reads test/live from it, never returns the secret', async () => {
      const { service, storeIntegrationModel } = build();
      const res = await service.connect(STORE_ID, SELLER_ID, 'payment', 'mollie' as any, { apiKey: 'test_abc123' });
      expect(res.success).toBe(true);
      const update = storeIntegrationModel.findOneAndUpdate.mock.calls[0][1];
      expect(update.$set.mode).toBe('sandbox');
      expect(update.$set.status).toBe('connected');
      expect(update.$set['config.currency']).toBe('EUR');
      expect(update.$set.lastVerifiedAt).toBeNull(); // never tested yet => cannot be switched on live until it is
      expect(JSON.parse(decryptCredential(update.$set.credentialsEncrypted, 'INTEGRATIONS'))).toEqual({ apiKey: 'test_abc123' });
      expect(update.$set['config.maskedHints'].apiKey).not.toContain('abc123');
      expect(update.$setOnInsert.webhookToken).toBeTruthy();
      expect(JSON.stringify(res.data)).not.toContain('credentialsEncrypted');
      expect((res.data as any).catalog.label).toBe('Mollie');
    });

    it('a live key connects in live mode; an explicit mode wins over the key (PayPal has none)', async () => {
      const a = build();
      await a.service.connect(STORE_ID, SELLER_ID, 'payment', 'mollie' as any, { apiKey: 'live_abc123' });
      expect(a.storeIntegrationModel.findOneAndUpdate.mock.calls[0][1].$set.mode).toBe('live');

      const b = build({ country: 'US', baseCurrency: 'USD' });
      await b.service.connect(STORE_ID, SELLER_ID, 'payment', 'paypal' as any, { clientId: 'c', clientSecret: 's', mode: 'live' });
      expect(b.storeIntegrationModel.findOneAndUpdate.mock.calls[0][1].$set.mode).toBe('live');
      const c = build({ country: 'US', baseCurrency: 'USD' });
      await c.service.connect(STORE_ID, SELLER_ID, 'payment', 'paypal' as any, { clientId: 'c', clientSecret: 's' });
      expect(c.storeIntegrationModel.findOneAndUpdate.mock.calls[0][1].$set.mode).toBe('sandbox');
    });

    it('names every missing field', async () => {
      const { service } = build({ country: 'US', baseCurrency: 'USD' });
      await expect(service.connect(STORE_ID, SELLER_ID, 'payment', 'paypal' as any, { clientId: 'c' })).rejects.toThrow('Client secret is required');
      await expect(service.connect(STORE_ID, SELLER_ID, 'payment', 'paypal' as any, {})).rejects.toThrow('Client ID, Client secret are required');
    });

    it('REGRESSION: refuses a gateway the store country cannot use (Razorpay for a German store, PayPal for Pakistan)', async () => {
      const de = build();
      await expect(de.service.connect(STORE_ID, SELLER_ID, 'payment', 'razorpay' as any, { keyId: 'rzp_test_1', keySecret: 's' })).rejects.toThrow('Razorpay is not available for stores in Germany');
      expect(de.storeIntegrationModel.findOneAndUpdate).not.toHaveBeenCalled();

      const pk = build({ country: 'PK', baseCurrency: 'PKR' });
      await expect(pk.service.connect(STORE_ID, SELLER_ID, 'payment', 'paypal' as any, { clientId: 'c', clientSecret: 's' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('the charge currency recorded is one the gateway takes (Razorpay is INR only)', async () => {
      const { service, storeIntegrationModel } = build({ country: 'IN', baseCurrency: 'USD' });
      await service.connect(STORE_ID, SELLER_ID, 'payment', 'razorpay' as any, { keyId: 'rzp_test_1', keySecret: 's' });
      expect(storeIntegrationModel.findOneAndUpdate.mock.calls[0][1].$set['config.currency']).toBe('INR');
    });
  });

  describe('list', () => {
    const providersOf = async (country: string, currency: string) => {
      const { service } = build({ country, baseCurrency: currency });
      const res: any = await service.list(STORE_ID, SELLER_ID);
      return res.data.payment.map((p: any) => p.provider);
    };

    it('shows each store only what its country can use (and Stripe Connect always, with a reason when unavailable)', async () => {
      expect(await providersOf('PK', 'PKR')).toEqual(['safepay', 'payfast', 'jazzcash', 'easypaisa', 'bank_transfer', 'stripe']);
      expect(await providersOf('DE', 'EUR')).toEqual(['stripe_standard', 'stripe_own', 'paypal', 'mollie', 'stripe']);
      expect(await providersOf('NG', 'NGN')).toEqual(['paypal', 'paystack', 'flutterwave', 'stripe']);
    });

    it('hides a gateway that has no implementation registered', async () => {
      const { service, registry } = build({ country: 'DE', baseCurrency: 'EUR' });
      registry.isSupported.mockImplementation((p: string) => p !== 'mollie');
      const res: any = await service.list(STORE_ID, SELLER_ID);
      expect(res.data.payment.map((p: any) => p.provider)).toEqual(['stripe_standard', 'stripe_own', 'paypal', 'stripe']);
    });

    it('gives the seller UI what it needs to draw a connect form and the webhook step from the catalog alone', async () => {
      const { service } = build({ country: 'DE', baseCurrency: 'EUR' });
      const res: any = await service.list(STORE_ID, SELLER_ID);
      const stripeOwn = res.data.payment.find((p: any) => p.provider === 'stripe_own');
      expect(stripeOwn.catalog).toMatchObject({ label: 'Stripe (your own account)', generic: true, webhook: 'secret', refunds: 'api', chargeCurrency: 'EUR' });
      expect(stripeOwn.catalog.fields[0]).toMatchObject({ key: 'secretKey', secret: true });
      expect(stripeOwn.status).toBe('not_connected');
      const mollie = res.data.payment.find((p: any) => p.provider === 'mollie');
      expect(mollie.catalog.webhook).toBe('none');
    });
  });

  it('every catalog-driven gateway can be connected through the same call', async () => {
    const creds: Record<string, Record<string, string>> = {
      stripe_own: { secretKey: 'sk_test_1' }, paypal: { clientId: 'c', clientSecret: 's' }, razorpay: { keyId: 'rzp_test_1', keySecret: 's' },
      paystack: { secretKey: 'sk_test_1' }, flutterwave: { secretKey: 'FLWSECK_TEST-1' }, mollie: { apiKey: 'test_1' },
    };
    const country: Record<string, [string, string]> = {
      stripe_own: ['US', 'USD'], paypal: ['US', 'USD'], razorpay: ['IN', 'INR'], paystack: ['NG', 'NGN'], flutterwave: ['NG', 'NGN'], mollie: ['DE', 'EUR'],
    };
    for (const key of GENERIC_GATEWAY_KEYS) {
      const [c, cur] = country[key];
      const { service } = build({ country: c, baseCurrency: cur });
      const res = await service.connect(STORE_ID, SELLER_ID, 'payment', key as any, creds[key]);
      expect(res.success).toBe(true);
    }
  });
});
