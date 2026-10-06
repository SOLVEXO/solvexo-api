/* eslint-disable prettier/prettier */
/** Pure helpers for live shipping rates / labels (no DB, no network). */

export type HandlingFeeType = 'flat' | 'percent';
export type PackageUnit = 'cm' | 'in';

export interface ShippingPackage {
  id: string;
  name: string;
  length: number;
  width: number;
  height: number;
  unit: PackageUnit;
  /** Weight of the empty package in kg. */
  emptyWeight: number;
  isDefault: boolean;
}

export const FALLBACK_PARCEL = { length: 20, width: 15, height: 10, unit: 'cm' as PackageUnit, emptyWeight: 0 };

/** Optional non-negative dimension (cm) from untyped input; anything else -> null. */
export function toDimensionCm(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Adds the seller's handling fee on top of a carrier amount (2dp). Invalid config = no fee. */
export function applyHandlingFee(amount: number, type?: string | null, value?: number | null): number {
  const v = Number(value);
  if (!Number.isFinite(amount)) return amount;
  if (!Number.isFinite(v) || v <= 0 || (type !== 'flat' && type !== 'percent')) return amount;
  const fee = type === 'flat' ? v : (amount * v) / 100;
  return Math.round((amount + fee) * 100) / 100;
}

/** The package to quote with: requested id, else the default, else the first, else null. */
export function pickPackage(packages: ShippingPackage[] | null | undefined, packageId?: string | null): ShippingPackage | null {
  const list = Array.isArray(packages) ? packages : [];
  if (packageId) {
    const found = list.find((p) => p.id === packageId);
    if (found) return found;
  }
  return list.find((p) => p.isDefault) ?? list[0] ?? null;
}

/** Shippo parcel for a package (or the legacy 20x15x10 cm box) + goods weight. */
export function buildParcel(pkg: ShippingPackage | null, goodsWeightKg: number) {
  const dims = pkg ?? { ...FALLBACK_PARCEL };
  const total = Math.max((Number.isFinite(goodsWeightKg) ? goodsWeightKg : 0) + (pkg?.emptyWeight ?? 0), 0.1);
  return {
    length: String(dims.length), width: String(dims.width), height: String(dims.height),
    distance_unit: dims.unit,
    weight: String(Math.round(total * 1000) / 1000), mass_unit: 'kg',
  };
}
