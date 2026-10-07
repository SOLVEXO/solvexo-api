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

// ---------------------------------------------------------------------------
// Shopify-style packing: items are packed by their own dimensions into the
// smallest saved package that holds them all; if no single package fits, the
// default package is filled box by box (first-fit-decreasing). Items with no
// dimensions add weight only. No saved packages -> legacy single fallback parcel.
// ---------------------------------------------------------------------------

export interface PackItem {
  /** Per-unit package dimensions in cm (null = not entered). */
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  /** Per-unit weight in kg. */
  weightKg: number;
  quantity: number;
}

export interface PackedParcel {
  /** Saved package used (or a synthetic box sized to an oversize item); null = legacy fallback parcel. */
  pkg: ShippingPackage | null;
  /** Weight of the goods only (kg); the package's empty weight is added by `buildParcel`. */
  goodsWeightKg: number;
}

const IN_TO_CM = 2.54;
const MAX_UNITS = 500; // safety cap on expanded units (very large carts)

function pkgDimsCm(p: ShippingPackage): [number, number, number] {
  const k = p.unit === 'in' ? IN_TO_CM : 1;
  return [p.length * k, p.width * k, p.height * k];
}
const sortDesc = (d: number[]) => [...d].sort((a, b) => b - a);
const volume = (d: number[]) => d[0] * d[1] * d[2];
function fitsInside(item: number[], box: number[]): boolean {
  const a = sortDesc(item), b = sortDesc(box);
  return a[0] <= b[0] + 1e-9 && a[1] <= b[1] + 1e-9 && a[2] <= b[2] + 1e-9;
}

export function packItems(items: PackItem[], packages: ShippingPackage[] | null | undefined): PackedParcel[] {
  const list = (Array.isArray(packages) ? packages : []).filter((p) => p.length > 0 && p.width > 0 && p.height > 0);
  const units: { dims: number[] | null; weightKg: number }[] = [];
  for (const it of items) {
    const q = Math.min(Math.max(Math.floor(it.quantity) || 1, 1), MAX_UNITS);
    const w = Number.isFinite(it.weightKg) && it.weightKg > 0 ? it.weightKg : 0;
    const hasDims = [it.lengthCm, it.widthCm, it.heightCm].every((x) => x != null && Number.isFinite(x) && (x as number) > 0);
    for (let i = 0; i < q && units.length < MAX_UNITS * 4; i++) {
      units.push({ dims: hasDims ? [it.lengthCm as number, it.widthCm as number, it.heightCm as number] : null, weightKg: w });
    }
  }
  const totalWeight = units.reduce((s, u) => s + u.weightKg, 0);
  const defaultPkg = pickPackage(list, null);
  if (list.length === 0) return [{ pkg: null, goodsWeightKg: totalWeight }];

  const dimmed = units.filter((u) => u.dims);
  if (dimmed.length === 0) return [{ pkg: defaultPkg, goodsWeightKg: totalWeight }];

  // 1) Smallest single saved package holding every item (each fits alone + combined volume fits).
  const totalVol = dimmed.reduce((s, u) => s + volume(u.dims as number[]), 0);
  const single = list
    .filter((p) => {
      const d = pkgDimsCm(p);
      return totalVol <= volume(d) + 1e-9 && dimmed.every((u) => fitsInside(u.dims as number[], d));
    })
    .sort((a, b) => volume(pkgDimsCm(a)) - volume(pkgDimsCm(b)))[0];
  if (single) return [{ pkg: single, goodsWeightKg: totalWeight }];

  // 2) Several boxes of the default package (largest one if it cannot hold an item); oversize items get their own box.
  const boxPkg = defaultPkg as ShippingPackage;
  const boxDims = pkgDimsCm(boxPkg);
  const bins: { pkg: ShippingPackage; cap: number; weight: number }[] = [];
  const sorted = [...dimmed].sort((a, b) => volume(b.dims as number[]) - volume(a.dims as number[]));
  const oversize: PackedParcel[] = [];
  for (const u of sorted) {
    const d = u.dims as number[];
    if (!fitsInside(d, boxDims)) {
      const [l, w, h] = sortDesc(d);
      oversize.push({
        pkg: { id: 'oversize', name: 'Oversize item', length: l, width: w, height: h, unit: 'cm', emptyWeight: 0, isDefault: false },
        goodsWeightKg: u.weightKg,
      });
      continue;
    }
    const bin = bins.find((b) => b.cap + 1e-9 >= volume(d));
    if (bin) { bin.cap -= volume(d); bin.weight += u.weightKg; }
    else bins.push({ pkg: boxPkg, cap: volume(boxDims) - volume(d), weight: u.weightKg });
  }
  const parcels: PackedParcel[] = [...bins.map((b) => ({ pkg: b.pkg, goodsWeightKg: b.weight })), ...oversize];
  const loose = units.filter((u) => !u.dims).reduce((s, u) => s + u.weightKg, 0);
  parcels[0].goodsWeightKg += loose;
  return parcels;
}
