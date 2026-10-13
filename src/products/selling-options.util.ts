import { BadRequestException } from '@nestjs/common';

export interface SellingOptions {
  vendor: string;
  orderMinQuantity: number;
  orderMaxQuantity: number | null;
  orderQuantityStep: number;
  preorder: { enabled: boolean; availableOn: Date | null };
}

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Validates the seller-entered selling options. Only fields present in `body` are returned,
 * so the same helper serves create (full defaults applied by the schema) and partial update.
 */
export function parseSellingOptions(body: any, current?: Partial<SellingOptions>): Partial<SellingOptions> {
  const out: Partial<SellingOptions> = {};
  if (body?.vendor !== undefined) {
    const v = String(body.vendor ?? '').trim();
    if (v.length > 100) throw new BadRequestException('Vendor / brand must be 100 characters or less');
    out.vendor = v;
  }
  const touched = ['orderMinQuantity', 'orderMaxQuantity', 'orderQuantityStep'].some((k) => body?.[k] !== undefined);
  if (touched) {
    const min = body.orderMinQuantity !== undefined ? toInt(body.orderMinQuantity) ?? 1 : current?.orderMinQuantity ?? 1;
    const maxRaw = body.orderMaxQuantity !== undefined ? toInt(body.orderMaxQuantity) : current?.orderMaxQuantity ?? null;
    const step = body.orderQuantityStep !== undefined ? toInt(body.orderQuantityStep) ?? 1 : current?.orderQuantityStep ?? 1;
    for (const n of [min, step]) if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 9999) throw new BadRequestException('Quantity rules must be whole numbers of 1 or more');
    if (maxRaw !== null && (!Number.isInteger(maxRaw) || maxRaw < 1 || maxRaw > 9999)) throw new BadRequestException('Maximum quantity must be a whole number of 1 or more');
    if (maxRaw !== null && maxRaw < (min as number)) throw new BadRequestException('Maximum quantity cannot be less than the minimum');
    out.orderMinQuantity = min as number;
    out.orderMaxQuantity = maxRaw as number | null;
    out.orderQuantityStep = step as number;
  }
  if (body?.preorder !== undefined) {
    const p = body.preorder ?? {};
    const enabled = p.enabled === true || p.enabled === 'true';
    let availableOn: Date | null = null;
    if (enabled && p.availableOn) {
      const d = new Date(p.availableOn);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Pre-order date is not valid');
      availableOn = d;
    }
    out.preorder = { enabled, availableOn };
  }
  return out;
}

/** Throws a buyer-readable error when `quantity` breaks the product's min / max / step rules. */
export function assertOrderQuantity(
  product: { name?: string; orderMinQuantity?: number | null; orderMaxQuantity?: number | null; orderQuantityStep?: number | null },
  quantity: number,
): void {
  const min = product.orderMinQuantity ?? 1;
  const max = product.orderMaxQuantity ?? null;
  const step = product.orderQuantityStep ?? 1;
  const name = product.name ?? 'This product';
  if (quantity < min) throw new BadRequestException(`"${name}" has a minimum order of ${min}.`);
  if (max !== null && quantity > max) throw new BadRequestException(`"${name}" has a maximum order of ${max}.`);
  if (step > 1 && (quantity - min) % step !== 0) throw new BadRequestException(`"${name}" must be ordered in multiples of ${step} (starting from ${min}).`);
}
