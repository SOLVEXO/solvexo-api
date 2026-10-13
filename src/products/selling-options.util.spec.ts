import { assertOrderQuantity, parseSellingOptions } from './selling-options.util';

describe('selling options', () => {
  it('parses vendor and quantity rules', () => {
    expect(parseSellingOptions({ vendor: ' Acme ', orderMinQuantity: 2, orderMaxQuantity: 10, orderQuantityStep: 2 }))
      .toEqual({ vendor: 'Acme', orderMinQuantity: 2, orderMaxQuantity: 10, orderQuantityStep: 2 });
  });
  it('rejects max below min and fractions', () => {
    expect(() => parseSellingOptions({ orderMinQuantity: 5, orderMaxQuantity: 3 })).toThrow();
    expect(() => parseSellingOptions({ orderMinQuantity: 1.5 })).toThrow();
  });
  it('pre-order needs a valid date when given', () => {
    expect(() => parseSellingOptions({ preorder: { enabled: true, availableOn: 'nope' } })).toThrow();
    expect(parseSellingOptions({ preorder: { enabled: false, availableOn: '2030-01-01' } }).preorder).toEqual({ enabled: false, availableOn: null });
  });
  it('enforces min / max / step at order time', () => {
    const p = { name: 'X', orderMinQuantity: 2, orderMaxQuantity: 8, orderQuantityStep: 2 };
    expect(() => assertOrderQuantity(p, 1)).toThrow();
    expect(() => assertOrderQuantity(p, 10)).toThrow();
    expect(() => assertOrderQuantity(p, 5)).toThrow();
    expect(() => assertOrderQuantity(p, 6)).not.toThrow();
    expect(() => assertOrderQuantity({}, 3)).not.toThrow();
  });
});
