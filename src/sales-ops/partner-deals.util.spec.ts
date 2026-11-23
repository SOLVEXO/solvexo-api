/* eslint-disable prettier/prettier */
import { addWorkingDays, conflictsFor, extendProtection, keysOf, nameKeyOf, phoneKeyOf, sameProspect } from './partner-deals.util';

const now = new Date('2026-11-25T10:00:00Z'); // a Wednesday

describe('deal registration rules (B7)', () => {
  it('counts working days, skipping the weekend', () => {
    expect(addWorkingDays(new Date('2026-11-25T10:00:00Z'), 2).toISOString().slice(0, 10)).toBe('2026-11-27'); // Wed → Fri
    expect(addWorkingDays(new Date('2026-11-27T10:00:00Z'), 2).toISOString().slice(0, 10)).toBe('2026-12-01'); // Fri → Tue
  });

  it('matches the same seller by phone (any format) or email, and only hints on a similar name', () => {
    expect(phoneKeyOf('+92 300-1234567')).toBe(phoneKeyOf('03001234567'));
    expect(nameKeyOf('Ali Traders (Pvt) Ltd')).toBe(nameKeyOf('ALI'));
    const a = keysOf({ phone: '0300 1234567', businessName: 'Ali Store' });
    expect(sameProspect(a, keysOf({ phone: '+923001234567' }))).toBe('strong');
    expect(sameProspect(a, keysOf({ email: 'x@y.pk', businessName: 'Ali' }))).toBe('name');
    expect(sameProspect(a, keysOf({ phone: '03111111111' }))).toBeNull();
  });

  const keys = keysOf({ phone: '03001234567', email: 'shop@x.pk', businessName: 'Hamza Mart' });
  const base = { keys, partnerId: 'me', others: [], customers: [], houseAccounts: [], now };

  it('rejects on its own an existing customer, a house account, and another partner’s protected registration', () => {
    expect(conflictsFor({ ...base, customers: [{ sellerId: 's1', name: 'Hamza Mart', keys: keysOf({ email: 'SHOP@x.pk' }) }] }).autoReject).toBe('Already a Solvexo customer.');
    expect(conflictsFor({ ...base, houseAccounts: ['shop@x.pk'] }).autoReject).toContain('house account');
    const other = { id: 'd1', partnerId: 'p2', partnerName: 'Lahore Traders', submittedAt: new Date('2026-11-01'), keys: keysOf({ phone: '+92 300 1234567' }) };
    expect(conflictsFor({ ...base, others: [{ ...other, status: 'accepted', protectedUntil: new Date('2027-01-01') }] }).autoReject).toBe('Already registered by another partner.');
  });

  it('leaves the decision to a manager when the other registration expired, is still pending, or only the name is alike', () => {
    const other = { id: 'd1', partnerId: 'p2', partnerName: 'Lahore Traders', submittedAt: new Date('2026-11-01'), keys: keysOf({ phone: '03001234567' }) };
    const expired = conflictsFor({ ...base, others: [{ ...other, status: 'accepted', protectedUntil: new Date('2026-11-20') }] });
    expect(expired.autoReject).toBeNull();
    const pending = conflictsFor({ ...base, others: [{ ...other, status: 'pending', protectedUntil: null }] });
    expect(pending.autoReject).toBeNull();
    expect(pending.conflicts[0]).toMatchObject({ kind: 'pending_elsewhere' });
    const nameOnly = conflictsFor({ ...base, customers: [{ sellerId: 's1', name: 'Hamza Mart', keys: { phoneKey: null, emailKey: null, nameKey: nameKeyOf('Hamza Mart') } }] });
    expect(nameOnly).toMatchObject({ autoReject: null, conflicts: [{ kind: 'name_match' }] });
  });

  it('ignores the partner’s own registrations', () => {
    const own = { id: 'd1', partnerId: 'me', partnerName: 'Me', status: 'accepted' as const, submittedAt: now, protectedUntil: new Date('2027-01-01'), keys };
    expect(conflictsFor({ ...base, others: [own] })).toEqual({ conflicts: [], autoReject: null });
  });

  it('extends protection from the current end, or from today once it has lapsed', () => {
    expect(extendProtection(new Date('2026-12-31T00:00:00Z'), now, 30).toISOString().slice(0, 10)).toBe('2027-01-30');
    expect(extendProtection(new Date('2026-11-01T00:00:00Z'), now, 30).toISOString().slice(0, 10)).toBe('2026-12-25');
  });
});
