import { isOpenAt } from './store-chat-settings.service';

const week = (over: Partial<Record<number, { open: boolean; from: string; to: string }>> = {}) =>
  [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, open: day >= 1 && day <= 5, from: '09:00', to: '18:00', ...over[day] }));

describe('isOpenAt', () => {
  // 2026-10-26 is a Monday
  it('is open inside the hours of an open day (store time zone)', () => {
    expect(isOpenAt(week(), 'Asia/Karachi', new Date('2026-10-26T07:00:00Z'))).toBe(true); // 12:00 PKT
  });
  it('is closed before opening and after closing', () => {
    expect(isOpenAt(week(), 'Asia/Karachi', new Date('2026-10-26T01:00:00Z'))).toBe(false); // 06:00 PKT
    expect(isOpenAt(week(), 'Asia/Karachi', new Date('2026-10-26T14:00:00Z'))).toBe(false); // 19:00 PKT
  });
  it('is closed on a closed day (Sunday)', () => {
    expect(isOpenAt(week(), 'Asia/Karachi', new Date('2026-10-25T07:00:00Z'))).toBe(false);
  });
  it('follows the store time zone, not the server', () => {
    expect(isOpenAt(week(), 'America/New_York', new Date('2026-10-26T07:00:00Z'))).toBe(false); // 03:00 in New York
  });
  it('supports an overnight shift', () => {
    const hours = week({ 1: { open: true, from: '20:00', to: '02:00' } });
    expect(isOpenAt(hours, 'UTC', new Date('2026-10-26T23:00:00Z'))).toBe(true);
    expect(isOpenAt(hours, 'UTC', new Date('2026-10-26T01:00:00Z'))).toBe(true);
    expect(isOpenAt(hours, 'UTC', new Date('2026-10-26T12:00:00Z'))).toBe(false);
  });
});
