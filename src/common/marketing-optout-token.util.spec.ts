import { signMarketingOptOutToken, verifyMarketingOptOutToken } from './marketing-optout-token.util';
import { signGiftCardViewToken } from './gift-card-view-token.util';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

describe('marketing opt-out token', () => {
  it('round-trips the store and a lower-cased email', () => {
    const t = signMarketingOptOutToken('s1', ' Buyer@Example.COM ');
    expect(verifyMarketingOptOutToken(t)).toEqual({ storeId: 's1', email: 'buyer@example.com' });
  });
  it('rejects a forged, truncated or empty token', () => {
    const t = signMarketingOptOutToken('s1', 'a@b.com');
    const [body, sig] = t.split('.');
    expect(verifyMarketingOptOutToken(`${body}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(verifyMarketingOptOutToken(body)).toBeNull();
    expect(verifyMarketingOptOutToken('')).toBeNull();
  });
  it('rejects an expired token', () => {
    expect(verifyMarketingOptOutToken(signMarketingOptOutToken('s1', 'a@b.com', -1))).toBeNull();
  });
  it('a token made for something else cannot unsubscribe anyone', () => {
    expect(verifyMarketingOptOutToken(signGiftCardViewToken('card1'))).toBeNull();
  });
});
