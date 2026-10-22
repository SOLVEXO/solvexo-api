import { BadRequestException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';

export const MAX_COMPLEMENTARY_PRODUCTS = 10;

/**
 * Cleans the list of "complementary products" a seller picked for one product:
 * must be a list, no duplicates, never the product itself, valid ids only, at most 10.
 * (Whether each id is really a live product of THIS store is checked against the database by the caller.)
 */
export function normalizeComplementaryIds(input: unknown, selfId: string): string[] {
  if (!Array.isArray(input)) throw new BadRequestException('complementaryProductIds must be a list');
  const wanted = [...new Set(input.map(x => String(x)))].filter(id => id !== String(selfId));
  if (wanted.length > MAX_COMPLEMENTARY_PRODUCTS) {
    throw new BadRequestException(`You can pick up to ${MAX_COMPLEMENTARY_PRODUCTS} complementary products`);
  }
  if (wanted.some(id => !isValidObjectId(id))) throw new BadRequestException('Invalid complementary product');
  return wanted;
}
