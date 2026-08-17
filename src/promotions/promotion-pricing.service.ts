/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { AdminConfigService } from '../admin-config/admin-config.service';

export interface PromotionPriceBreakdown {
  unit: 'monthly' | 'weekly' | 'daily' | 'hourly' | 'festival';
  baseRate: number;
  hours: number;
  weekendFraction: number;
  weekendMultiplierApplied: number;
  peakMultiplierApplied: number;
  festivalName?: string;
  priceUSD: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/** Fraction of the [startAt,endAt) window that falls on a Saturday/Sunday —
 *  hour-by-hour for anything up to a year, a cheap linear-time proportion
 *  estimate beyond that (promotions realistically never run that long). */
function weekendFraction(startAt: Date, endAt: Date): number {
  const totalHours = Math.max(0, (endAt.getTime() - startAt.getTime()) / MS_PER_HOUR);
  if (totalHours === 0) return 0;

  if (totalHours <= 24 * 366) {
    let weekendHours = 0;
    const cursor = new Date(startAt);
    for (let i = 0; i < Math.ceil(totalHours); i++) {
      const day = cursor.getUTCDay();
      if (day === 0 || day === 6) weekendHours++;
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    }
    return weekendHours / totalHours;
  }
  return 2 / 7; // long-running promotions: assume the calendar average
}

@Injectable()
export class PromotionPricingService {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  /** Shared by both the seller-facing price preview and the actual charge —
   *  the two must never be able to drift (same discipline as `computeProration()`
   *  in platform-plans). */
  async computePrice(placement: string, startAt: Date, endAt: Date, isPeak = false): Promise<PromotionPriceBreakdown> {
    const rates = await this.adminConfigService.getPromotionPricing(placement);
    const hours = Math.max(0, (endAt.getTime() - startAt.getTime()) / MS_PER_HOUR);

    const activeFestival = (rates.festivalOverrides ?? []).find(
      (f: any) => new Date(f.startAt).getTime() <= endAt.getTime() && new Date(f.endAt).getTime() >= startAt.getTime(),
    );
    if (activeFestival) {
      return {
        unit: 'festival',
        baseRate: activeFestival.rate,
        hours,
        weekendFraction: 0,
        weekendMultiplierApplied: 1,
        peakMultiplierApplied: 1,
        festivalName: activeFestival.name,
        priceUSD: Math.round(activeFestival.rate * 100) / 100,
      };
    }

    const months = hours / (24 * 30);
    const weeks = hours / (24 * 7);
    const days = hours / 24;

    let unit: PromotionPriceBreakdown['unit'] = 'hourly';
    let baseRate = (rates.hourly ?? 0) * hours;
    if (rates.monthly && months >= 1) { unit = 'monthly'; baseRate = rates.monthly * months; }
    else if (rates.weekly && weeks >= 1) { unit = 'weekly'; baseRate = rates.weekly * weeks; }
    else if (rates.daily && days >= 1) { unit = 'daily'; baseRate = rates.daily * days; }

    const wknd = weekendFraction(startAt, endAt);
    const weekendMultiplierApplied = 1 + wknd * ((rates.weekendMultiplier ?? 1) - 1);
    const peakMultiplierApplied = isPeak ? (rates.peakMultiplier ?? 1) : 1;

    const priceUSD = Math.round(baseRate * weekendMultiplierApplied * peakMultiplierApplied * 100) / 100;

    return { unit, baseRate, hours, weekendFraction: wknd, weekendMultiplierApplied, peakMultiplierApplied, priceUSD };
  }
}
