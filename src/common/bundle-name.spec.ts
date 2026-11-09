import { componentDisplayName } from './bundle.util';

describe('componentDisplayName (staging smoke 3: bundle lines showed "Item x 2")', () => {
  it('uses the product name and appends the variant options', () => {
    expect(componentDisplayName('Smoke Shirt', [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Blue' }])).toBe('Smoke Shirt (M / Blue)');
    expect(componentDisplayName('Smoke Socks', [])).toBe('Smoke Socks');
    expect(componentDisplayName('Smoke Socks', null)).toBe('Smoke Socks');
  });
  it('returns null when the product is unknown (the order then keeps its fallback label)', () => {
    expect(componentDisplayName(undefined, [{ value: 'M' }])).toBeNull();
    expect(componentDisplayName('  ', [])).toBeNull();
  });
});
