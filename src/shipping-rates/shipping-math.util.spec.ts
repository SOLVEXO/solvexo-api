/* eslint-disable prettier/prettier */
import { applyHandlingFee, buildParcel, pickPackage, toDimensionCm, ShippingPackage } from './shipping-math.util';

const pkgs: ShippingPackage[] = [
  { id: 'a', name: 'Small', length: 10, width: 10, height: 5, unit: 'cm', emptyWeight: 0.1, isDefault: false },
  { id: 'b', name: 'Box', length: 30, width: 20, height: 15, unit: 'in', emptyWeight: 0.3, isDefault: true },
];

describe('shipping-math.util', () => {
  it('toDimensionCm accepts only non-negative numbers', () => {
    expect(toDimensionCm('12.5')).toBe(12.5);
    expect(toDimensionCm(0)).toBe(0);
    expect(toDimensionCm(-1)).toBeNull();
    expect(toDimensionCm('abc')).toBeNull();
    expect(toDimensionCm(null)).toBeNull();
    expect(toDimensionCm('')).toBeNull();
  });

  it('applyHandlingFee flat / percent / invalid', () => {
    expect(applyHandlingFee(10, 'flat', 2)).toBe(12);
    expect(applyHandlingFee(10, 'percent', 15)).toBe(11.5);
    expect(applyHandlingFee(10, undefined, 5)).toBe(10);
    expect(applyHandlingFee(10, 'flat', -3)).toBe(10);
    expect(applyHandlingFee(9.99, 'percent', 10)).toBe(10.99);
  });

  it('pickPackage prefers requested, then default, then first', () => {
    expect(pickPackage(pkgs, 'a')?.id).toBe('a');
    expect(pickPackage(pkgs)?.id).toBe('b');
    expect(pickPackage(pkgs, 'zzz')?.id).toBe('b');
    expect(pickPackage([{ ...pkgs[0] }])?.id).toBe('a');
    expect(pickPackage([])).toBeNull();
  });

  it('buildParcel falls back to 20x15x10 and adds empty weight', () => {
    expect(buildParcel(null, 0.05)).toMatchObject({ length: '20', width: '15', height: '10', distance_unit: 'cm', weight: '0.1' });
    expect(buildParcel(pkgs[1], 1)).toMatchObject({ length: '30', distance_unit: 'in', weight: '1.3' });
  });
});
