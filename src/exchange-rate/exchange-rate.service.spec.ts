/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { ExchangeRateService } from './exchange-rate.service';
import { DatabaseService } from '../database/databaseservice';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { FxSnapshot } from './schemas/exchange-rate.schema';

const DEFAULT_FX_CONFIG = {
  autoRefreshEnabled: true,
  refreshIntervalHours: 24,
  staleRateAlertThresholdHours: 48,
  sanityBandMinPKR: 150,
  sanityBandMaxPKR: 450,
  abnormalJumpAlertPercent: 8,
};

describe('ExchangeRateService', () => {
  let service: ExchangeRateService;
  let model: any;
  let db: DatabaseService;
  let adminConfigService: AdminConfigService;
  let activityLogService: ActivityLogService;

  /** Mirrors the real `.findOne(...).sort(...).lean()` chain used by getCurrentRate. */
  const leanFindOneSorted = (value: any) => ({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }),
  });

  beforeEach(() => {
    model = {
      findOne: jest.fn().mockReturnValue(leanFindOneSorted(null)),
      create: jest.fn().mockImplementation(async (doc: any) => ({ ...doc, _id: 'rate-1' })),
    };
    db = { repositories: { exchangeRateModel: model } } as any;
    adminConfigService = { getFxConfig: jest.fn().mockResolvedValue(DEFAULT_FX_CONFIG) } as any;
    activityLogService = { log: jest.fn() } as any;
    service = new ExchangeRateService(db, adminConfigService, activityLogService);
  });

  describe('convertWithSnapshots — the core money-safety primitive', () => {
    const snapshots: FxSnapshot[] = [
      { currency: 'PKR', ratePerUSD: 278, effectiveFrom: new Date(), source: 'provider', exchangeRateId: 'r1' },
    ];

    it('is a no-op when source and target currency are the same', () => {
      expect(service.convertWithSnapshots(20000, 'PKR', 'PKR', snapshots)).toBe(20000);
    });

    it('converts PKR -> USD using the snapshotted rate, never the raw number', () => {
      // This is the direct regression test for the confirmed §0 hazard:
      // a PKR-priced product must never be charged as the same numeric
      // amount in USD (e.g. PKR 20,000 must never become USD 20,000).
      const result = service.convertWithSnapshots(20000, 'PKR', 'USD', snapshots);
      expect(result).toBeCloseTo(20000 / 278, 2);
      expect(result).not.toBe(20000);
      expect(result).toBeLessThan(100); // sanity: a few thousand PKR is a handful of USD, not thousands
    });

    it('converts USD -> PKR using the snapshotted rate', () => {
      const result = service.convertWithSnapshots(72.46, 'USD', 'PKR', snapshots);
      expect(result).toBeCloseTo(72.46 * 278, 0);
    });

    it('treats USD as the pivot even when no explicit USD snapshot entry exists', () => {
      // USD always resolves to rate 1 without needing its own snapshot row —
      // this is what lets a 2-currency snapshot array serve an N-currency
      // conversion later without a rewrite.
      expect(() => service.convertWithSnapshots(100, 'USD', 'USD', snapshots)).not.toThrow();
    });

    it('throws rather than silently guessing when a required currency has no snapshot', () => {
      expect(() => service.convertWithSnapshots(100, 'EUR', 'USD', snapshots)).toThrow(BadRequestException);
    });

    it('never rounds the intermediate USD pivot value — only the final result', () => {
      // A two-hop PKR -> USD -> (hypothetical third currency) conversion
      // must not lose precision at the USD step. We can't fully exercise a
      // 3rd currency without one configured, but we can assert the PKR->USD
      // leg itself retains full precision before final rounding.
      const oddPkr = 12345;
      const result = service.convertWithSnapshots(oddPkr, 'PKR', 'USD', snapshots);
      // 12345 / 278 = 44.406474... -> rounded to cents = 44.41, not 44.4 or 44
      expect(result).toBe(Math.round((oddPkr / 278) * 100) / 100);
    });
  });

  describe('roundForCurrency', () => {
    it('rounds PKR to whole rupees (no paisa in consumer pricing)', () => {
      expect(service.roundForCurrency(72.46 * 278, 'PKR')).toBe(Math.round(72.46 * 278));
      expect(Number.isInteger(service.roundForCurrency(1234.7, 'PKR'))).toBe(true);
    });

    it('rounds USD to cents', () => {
      expect(service.roundForCurrency(20000 / 278, 'USD')).toBeCloseTo(71.94, 2);
    });
  });

  describe('ingestRate — sanity band and abnormal-jump gating', () => {
    it('rejects a rate outside the configured sane band and does not promote it to current', async () => {
      await expect(service.ingestRate('PKR', 999999, 'provider')).rejects.toThrow(BadRequestException);
      expect(model.create).toHaveBeenCalledWith(expect.objectContaining({ isRejected: true }));
    });

    it('rejects a zero or negative rate', async () => {
      await expect(service.ingestRate('PKR', 0, 'provider')).rejects.toThrow(BadRequestException);
      await expect(service.ingestRate('PKR', -50, 'provider')).rejects.toThrow(BadRequestException);
    });

    it('holds (does not apply) a provider rate that jumps beyond the abnormal-jump threshold, even within the sane band', async () => {
      model.findOne.mockReturnValue(leanFindOneSorted({ ratePerUSD: 278, effectiveFrom: new Date(), source: 'provider' }));
      // 278 -> 320 is a ~15% jump, above the 8% default threshold, but still inside [150,450]
      const result = await service.ingestRate('PKR', 320, 'provider');
      expect(result.applied).toBe(false);
      expect(result.held).toBe(true);
      expect(model.create).toHaveBeenCalledWith(expect.objectContaining({ isRejected: true, ratePerUSD: 320 }));
    });

    it('applies a provider rate that is within both the sane band and the jump threshold', async () => {
      model.findOne.mockReturnValue(leanFindOneSorted({ ratePerUSD: 278, effectiveFrom: new Date(), source: 'provider' }));
      const result = await service.ingestRate('PKR', 280, 'provider'); // <1% jump
      expect(result.applied).toBe(true);
      expect(model.create).toHaveBeenCalledWith(expect.objectContaining({ isRejected: false, ratePerUSD: 280 }));
    });

    it('lets an admin override skip the abnormal-jump check (but still enforces the sane band)', async () => {
      model.findOne.mockReturnValue(leanFindOneSorted({ ratePerUSD: 278, effectiveFrom: new Date(), source: 'provider' }));
      const result = await service.ingestRate('PKR', 350, 'admin', { adminId: 'admin-1' }); // big jump, admin-initiated
      expect(result.applied).toBe(true);
      expect(activityLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'fx_rate_admin_override' }),
      );
    });
  });

  describe('getAllCurrentRates', () => {
    it('returns the latest stored row for each supported currency', async () => {
      model.findOne.mockImplementation((filter: any) =>
        leanFindOneSorted(
          filter.currency === 'USD'
            ? { currency: 'USD', ratePerUSD: 1, effectiveFrom: new Date(), source: 'admin' }
            : { currency: 'PKR', ratePerUSD: 278, effectiveFrom: new Date(), source: 'provider' },
        ),
      );
      const rates = await service.getAllCurrentRates();
      expect(rates.USD).toEqual(expect.objectContaining({ ratePerUSD: 1 }));
      expect(rates.PKR).toEqual(expect.objectContaining({ ratePerUSD: 278 }));
    });

    it('returns null for a currency with no stored rate yet, rather than guessing', async () => {
      const rates = await service.getAllCurrentRates(); // default mock resolves null for everything
      expect(rates.PKR).toBeNull();
    });
  });
});
