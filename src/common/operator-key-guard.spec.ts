import { findOperatorKey, isOperatorGuardExempt, operatorKeyGuard } from './operator-key-guard';

describe('operator-key guard', () => {
  it('finds $-keys at any depth', () => {
    expect(findOperatorKey({ email: { $ne: null } })).toBe('email.$ne');
    expect(findOperatorKey({ items: [{ a: 1 }, { b: { $gt: 0 } }] })).toBe('items[1].b.$gt');
    expect(findOperatorKey({ $where: 'sleep(1000)' })).toBe('$where');
  });

  it('finds prototype-pollution keys', () => {
    expect(findOperatorKey(JSON.parse('{"a":{"__proto__":{"isAdmin":true}}}'))).toBe('a.__proto__');
    expect(findOperatorKey({ constructor: { prototype: { x: 1 } } })).toBe('constructor.prototype');
    expect(findOperatorKey({ product: { prototype: 'v2' } })).toBeNull();
  });

  it('allows ordinary payloads, including $ inside values and dotted keys', () => {
    expect(findOperatorKey({ price: '$5', note: 'costs $10', 'custom.color': 'red', list: ['$x'] })).toBeNull();
    expect(findOperatorKey(null)).toBeNull();
    expect(findOperatorKey('$ne')).toBeNull();
  });

  it('exempts provider webhooks only', () => {
    expect(isOperatorGuardExempt('/api/payment/stripe/webhook')).toBe(true);
    expect(isOperatorGuardExempt('/api/integrations/webhooks/safepay?x=1')).toBe(true);
    expect(isOperatorGuardExempt('/api/auth/login')).toBe(false);
  });

  it('rejects with 400 and does not call the handler', () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    operatorKeyGuard({ body: { email: { $ne: null } }, originalUrl: '/api/auth/login' } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes clean requests and webhooks through', () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    operatorKeyGuard({ body: { email: 'a@b.com' }, originalUrl: '/api/auth/login' } as any, res, next);
    operatorKeyGuard({ body: { $anything: 1 }, originalUrl: '/api/payment/stripe/webhook' } as any, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
  });
});
