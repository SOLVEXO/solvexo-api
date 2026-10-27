import { signGiftCardViewToken, verifyGiftCardViewToken } from './gift-card-view-token.util';
import { signOrderStatusToken } from './order-status-token.util';

describe('gift card view token', () => {
  const prev = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });
  afterAll(() => { process.env.JWT_SECRET = prev; });

  it('round-trips the gift card id', () => {
    expect(verifyGiftCardViewToken(signGiftCardViewToken('64b000000000000000000001'))).toBe('64b000000000000000000001');
  });

  it('rejects a tampered token', () => {
    const [body, sig] = signGiftCardViewToken('64b000000000000000000001').split('.');
    const forged = Buffer.from(JSON.stringify({ g: '64b000000000000000000002', e: Date.now() + 1e9, p: 'gift_card_view' })).toString('base64url');
    expect(verifyGiftCardViewToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyGiftCardViewToken(`${body}.x${sig}`)).toBeNull();
  });

  it('rejects an expired token, junk and an order-status token', () => {
    expect(verifyGiftCardViewToken(signGiftCardViewToken('64b000000000000000000001', -1))).toBeNull();
    expect(verifyGiftCardViewToken('')).toBeNull();
    expect(verifyGiftCardViewToken('not-a-token')).toBeNull();
    expect(verifyGiftCardViewToken(signOrderStatusToken('64b000000000000000000001'))).toBeNull();
  });
});
