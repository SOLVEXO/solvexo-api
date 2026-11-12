/* eslint-disable prettier/prettier */
import { localDay, localHour, localKey, localRange } from './pos-day.util';

/** G4.0: every day of the till is a day in the store's time zone — DST-free (Asia/Karachi) and DST (Europe/London, America/New_York) zones. */
describe('store-time-zone days', () => {
  it('Asia/Karachi (UTC+5, no DST): a day runs 19:00 UTC → 19:00 UTC; 23:30 local is still that day; 00:30 local is the next', () => {
    const d = localDay('2026-11-09', 'Asia/Karachi');
    expect([d.start.toISOString(), d.end.toISOString(), d.key]).toEqual(['2026-11-08T19:00:00.000Z', '2026-11-09T19:00:00.000Z', '2026-11-09']);
    expect(localKey(new Date('2026-11-09T18:30:00Z'), 'Asia/Karachi')).toBe('2026-11-09'); // 23:30 PKT
    expect(localKey(new Date('2026-11-09T19:30:00Z'), 'Asia/Karachi')).toBe('2026-11-10'); // 00:30 PKT next day — the UTC date would still say the 9th
    expect(localHour(new Date('2026-11-09T18:30:00Z'), 'Asia/Karachi')).toBe(23);
  });
  it('Europe/London: the spring-forward day has 23 hours, the fall-back day 25; ordinary days 24', () => {
    const spring = localDay('2026-03-29', 'Europe/London');
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const autumn = localDay('2026-10-25', 'Europe/London');
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
    const summer = localDay('2026-07-01', 'Europe/London');
    expect([summer.start.toISOString(), (summer.end.getTime() - summer.start.getTime()) / 3_600_000]).toEqual(['2026-06-30T23:00:00.000Z', 24]);
  });
  it('America/New_York across the November change: consecutive days touch exactly (no gap, no overlap)', () => {
    const a = localDay('2026-10-31', 'America/New_York'); const b = localDay('2026-11-01', 'America/New_York'); const c = localDay('2026-11-02', 'America/New_York');
    expect(a.end.getTime()).toBe(b.start.getTime());
    expect(b.end.getTime()).toBe(c.start.getTime());
    expect((b.end.getTime() - b.start.getTime()) / 3_600_000).toBe(25);
    expect(b.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });
  it('an instant names its LOCAL day; nothing = today; a from/to range covers whole local days (to inclusive)', () => {
    expect(localDay('2026-11-09T20:00:00Z', 'Asia/Karachi').key).toBe('2026-11-10');
    expect(localDay(undefined, 'Asia/Karachi', new Date('2026-11-09T20:00:00Z')).key).toBe('2026-11-10');
    const r = localRange('2026-11-01', '2026-11-03', 'Asia/Karachi');
    expect([r.$gte!.toISOString(), r.$lt!.toISOString()]).toEqual(['2026-10-31T19:00:00.000Z', '2026-11-03T19:00:00.000Z']);
    expect(localRange(undefined, '2026-11-03', 'UTC')).toEqual({ $lt: new Date('2026-11-04T00:00:00.000Z') });
  });
});
