/* eslint-disable prettier/prettier */
import { reopenReleasableCredit, reopenedReturnStatus } from './order-exchange-reopen.util';

describe('exchange reopen helpers', () => {
  it('goes back to the status the line had before the exchange', () => {
    expect(reopenedReturnStatus({ prevReturnStatus: 'requested' })).toBe('requested');
    expect(reopenedReturnStatus({ prevReturnStatus: 'approved' })).toBe('approved');
    expect(reopenedReturnStatus({ prevReturnStatus: 'received' })).toBe('received');
  });
  it('a line the exchange restocked reopens as received (no double restock later)', () => {
    expect(reopenedReturnStatus({ prevReturnStatus: 'approved', restocked: true })).toBe('received');
  });
  it('unknown previous status falls back to approved', () => {
    expect(reopenedReturnStatus({ prevReturnStatus: 'weird' })).toBe('approved');
  });
  it('only the unspent part of the credit goes back to the refund budget', () => {
    expect(reopenReleasableCredit(100, 0)).toBe(100);
    expect(reopenReleasableCredit(100, 30)).toBe(70);
    expect(reopenReleasableCredit(50, 80)).toBe(0);
  });
});
