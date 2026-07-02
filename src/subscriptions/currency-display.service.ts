/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// NOTE: PKR_EXCHANGE_RATE is a manual placeholder (~278 as of mid-2025).
// Update this value in .env regularly, or wire this service to a live FX API
// (e.g., ExchangeRate-API, Open Exchange Rates) for production accuracy.
const FALLBACK_PKR_RATE = 278;

/**
 * CurrencyDisplayService — cosmetic USD→PKR conversion for customer-facing pages.
 *
 * NEVER use this for billing amounts, invoice totals, seller dashboard figures,
 * MRR/ARR, or any financial calculation. The system of record is always USD.
 */
@Injectable()
export class CurrencyDisplayService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Convert a USD amount for display only.
   * @param amountUSD      The canonical USD amount (stored on the plan)
   * @param targetCurrency The currency to display: 'USD' | 'PKR'
   * @param snapshotRate   Preferred: use the rate captured at plan creation (exchangeRateSnapshot).
   *                       Falls back to PKR_EXCHANGE_RATE env var, then hardcoded fallback.
   */
  formatForDisplay(
    amountUSD: number,
    targetCurrency: 'USD' | 'PKR',
    snapshotRate?: number | null,
  ): number {
    if (targetCurrency !== 'PKR') return amountUSD;
    const rate = snapshotRate
      ?? this.config.get<number>('PKR_EXCHANGE_RATE')
      ?? FALLBACK_PKR_RATE;
    return Math.round(amountUSD * rate);
  }

  getCurrentPkrRate(): number {
    return this.config.get<number>('PKR_EXCHANGE_RATE') ?? FALLBACK_PKR_RATE;
  }
}
