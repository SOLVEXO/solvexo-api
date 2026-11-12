/* eslint-disable prettier/prettier */
import { signCodConfirmToken, verifyCodConfirmToken } from './cod-confirm-token.util';
import { signGiftCardViewToken } from '../common/gift-card-view-token.util';

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });

describe('COD confirmation token', () => {
  const exp = Date.now() + 3600_000;
  it('round-trips the order id, send id and expiry', () => {
    const t = signCodConfirmToken('o1', 'abc', exp);
    expect(verifyCodConfirmToken(t)).toEqual({ orderId: 'o1', tokenId: 'abc', expiresAt: exp });
  });
  it('rejects tampering, another secret, expiry, garbage and tokens made for something else', () => {
    const t = signCodConfirmToken('o1', 'abc', exp);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ o: 'o2', t: 'abc', e: exp, p: 'cod_confirm' })).toString('base64url');
    expect(verifyCodConfirmToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyCodConfirmToken(`${body}.${sig}x`)).toBeNull();
    expect(verifyCodConfirmToken(signCodConfirmToken('o1', 'abc', Date.now() - 1))).toBeNull();
    expect(verifyCodConfirmToken(t, exp + 1)).toBeNull();
    expect(verifyCodConfirmToken('nope')).toBeNull();
    expect(verifyCodConfirmToken('x'.repeat(500))).toBeNull();
    expect(verifyCodConfirmToken(signGiftCardViewToken('g1'))).toBeNull();
    process.env.JWT_SECRET = 'other';
    expect(verifyCodConfirmToken(t)).toBeNull();
    process.env.JWT_SECRET = 'test-secret';
  });
});
