/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import {
  assertMoney, assertStockQuantity, copySku, findDuplicateSku, generateSkus, normalizeBarcode, normalizeSku,
  normalizeStatus, resolveScheduledAt,
} from './product-input.util';

describe('product-input.util', () => {
  describe('assertMoney', () => {
    it('rounds to cents', () => expect(assertMoney(10.005 + 0.1, 'Price')).toBe(10.11));
    it.each([-1, NaN, Infinity, '5', null, undefined])('rejects %p', (v) => {
      expect(() => assertMoney(v, 'Price')).toThrow(BadRequestException);
    });
    it('accepts zero', () => expect(assertMoney(0, 'Price')).toBe(0));
  });

  describe('assertStockQuantity', () => {
    it('accepts whole numbers', () => expect(assertStockQuantity(7)).toBe(7));
    it.each([-1, 1.5, NaN, '3', null])('rejects %p', (v) => {
      expect(() => assertStockQuantity(v)).toThrow(BadRequestException);
    });
  });

  describe('SKU / barcode', () => {
    it('trims and nulls blanks', () => {
      expect(normalizeSku('  AB-1 ')).toBe('AB-1');
      expect(normalizeSku('   ')).toBeNull();
      expect(normalizeSku(undefined)).toBeNull();
    });
    it('rejects spaces, non-text and over-long SKUs', () => {
      expect(() => normalizeSku('A B')).toThrow(BadRequestException);
      expect(() => normalizeSku(12 as any)).toThrow(BadRequestException);
      expect(() => normalizeSku('x'.repeat(500))).toThrow(BadRequestException);
    });
    it('accepts numeric barcodes', () => expect(normalizeBarcode(123456)).toBe('123456'));
    it('rejects object barcodes', () => expect(() => normalizeBarcode({} as any)).toThrow(BadRequestException));
  });

  describe('generateSkus', () => {
    it('is deterministic and skips taken values', () => {
      const out = generateSkus('abcdef123456', 3, ['SKU-123456-1', 'SKU-123456-3']);
      expect(out).toEqual(['SKU-123456-2', 'SKU-123456-4', 'SKU-123456-5']);
      expect(new Set(out).size).toBe(3);
    });
  });

  it('findDuplicateSku finds the first repeat and ignores blanks', () => {
    expect(findDuplicateSku(['A', 'B', null, '', 'A'])).toBe('A');
    expect(findDuplicateSku(['A', 'B', null, ''])).toBeNull();
  });

  describe('copySku', () => {
    it('suffixes -COPY then numbers further copies', () => {
      const taken = new Set<string>();
      expect(copySku('ABC', taken)).toBe('ABC-COPY');
      expect(copySku('ABC', taken)).toBe('ABC-COPY-2');
      expect(copySku('ABC', taken)).toBe('ABC-COPY-3');
    });
  });

  describe('status / scheduling', () => {
    it('defaults to draft, rejects unknown', () => {
      expect(normalizeStatus(undefined)).toBe('draft');
      expect(() => normalizeStatus('bogus')).toThrow(BadRequestException);
    });
    it('only scheduled products carry a date', () => {
      expect(resolveScheduledAt('active', '2030-01-01')).toBeNull();
    });
    it('requires a valid future date for scheduled', () => {
      const now = new Date('2026-10-13T00:00:00Z');
      expect(() => resolveScheduledAt('scheduled', undefined, now)).toThrow(BadRequestException);
      expect(() => resolveScheduledAt('scheduled', 'nope', now)).toThrow(BadRequestException);
      expect(() => resolveScheduledAt('scheduled', '2026-10-01', now)).toThrow(BadRequestException);
      expect(resolveScheduledAt('scheduled', '2026-10-14T00:00:00Z', now)?.toISOString()).toBe('2026-10-14T00:00:00.000Z');
    });
  });
});
