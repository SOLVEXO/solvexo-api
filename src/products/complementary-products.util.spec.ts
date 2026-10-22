import { BadRequestException } from '@nestjs/common';
import { normalizeComplementaryIds } from './complementary-products.util';

const id = (n: number) => n.toString(16).padStart(24, '0');

describe('normalizeComplementaryIds', () => {
  it('keeps valid ids in the seller\'s order', () => {
    expect(normalizeComplementaryIds([id(3), id(1), id(2)], id(9))).toEqual([id(3), id(1), id(2)]);
  });
  it('drops duplicates and the product itself', () => {
    expect(normalizeComplementaryIds([id(1), id(1), id(9), id(2)], id(9))).toEqual([id(1), id(2)]);
  });
  it('an empty list clears the picks', () => {
    expect(normalizeComplementaryIds([], id(9))).toEqual([]);
  });
  it('rejects anything that is not a list', () => {
    expect(() => normalizeComplementaryIds('abc', id(9))).toThrow(BadRequestException);
    expect(() => normalizeComplementaryIds(null, id(9))).toThrow(BadRequestException);
  });
  it('rejects ids that are not real object ids', () => {
    expect(() => normalizeComplementaryIds(['not-an-id'], id(9))).toThrow(BadRequestException);
  });
  it('allows exactly 10 but not 11', () => {
    const ten = Array.from({ length: 10 }, (_, i) => id(i + 1));
    expect(normalizeComplementaryIds(ten, id(99))).toHaveLength(10);
    expect(() => normalizeComplementaryIds([...ten, id(11)], id(99))).toThrow(BadRequestException);
  });
  it('picking the product itself does not count toward the limit', () => {
    const ten = Array.from({ length: 10 }, (_, i) => id(i + 1));
    expect(normalizeComplementaryIds([...ten, id(99)], id(99))).toHaveLength(10);
  });
});
