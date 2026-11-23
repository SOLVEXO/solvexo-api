/* eslint-disable prettier/prettier */
import { actionTitle, cleanDescription, csvCell, describeChanges, diffFields, formatInTimezone, orderIdsIn, toCsv } from './activity-log-format.util';

describe('activity-log format helpers', () => {
  it('turns an action slug into a readable title (acronyms kept)', () => {
    expect(actionTitle('seo_audit_run')).toBe('SEO audit run');
    expect(actionTitle('login_failed')).toBe('Login failed');
  });

  it('formats a date in the store timezone and falls back to UTC for a bad zone', () => {
    expect(formatInTimezone('2026-11-23T05:00:22Z', 'Asia/Karachi')).toBe('2026-11-23 10:00:22');
    expect(formatInTimezone('2026-11-23T05:00:22Z', 'Not/AZone')).toBe('2026-11-23 05:00:22');
  });

  it('swaps internal ids for customer-facing numbers', () => {
    const id = '6afada48cccb138ee5ac5a5a';
    expect(orderIdsIn(`Order #${id} — completed`)).toEqual([id]);
    expect(cleanDescription(`Order #${id} done`, new Map([[id, 'ORD-1']]))).toBe('Order #ORD-1 done');
    expect(cleanDescription(`Recovery email sent for checkout ${id}`, new Map())).toBe('Recovery email sent for checkout #ac5a5a');
  });

  it('builds a CSV Excel can open: BOM, CRLF, escaped quotes, no formula injection', () => {
    const csv = toCsv(['a', 'b'], [['=1+1', 'he said "hi"']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"he said ""hi"""');
    expect(csvCell(null)).toBe('""');
  });

  it('diffFields keeps only fields that really changed and ignores fields not in the update', () => {
    const changes = diffFields({ price: 10, name: 'A', tags: ['x'] }, { price: 12, name: 'A' }, ['price', 'name', 'tags']);
    expect(changes).toEqual([{ field: 'price', before: 10, after: 12 }]);
    expect(describeChanges(changes)).toBe('price: 10 → 12');
  });

  it('clips very long values so a log row stays small', () => {
    const [c] = diffFields({ d: 'a' }, { d: 'b'.repeat(500) }, ['d']);
    expect(String(c.after).length).toBeLessThanOrEqual(201);
  });
});
