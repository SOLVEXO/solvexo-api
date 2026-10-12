/* eslint-disable prettier/prettier */
import { ScheduledReportsService } from './scheduled-reports.service';
import { CSV_ROW_LIMIT, limitCsvRows, toCsv } from './utils/csv.util';

describe('ScheduledReportsService.dueSchedules', () => {
  it('weekly fires on Monday, monthly on the 1st (UTC)', () => {
    expect(ScheduledReportsService.dueSchedules(new Date('2026-10-12T06:00:00Z'))).toEqual(['weekly']); // Monday
    expect(ScheduledReportsService.dueSchedules(new Date('2026-11-01T06:00:00Z'))).toEqual(['monthly']); // Sunday the 1st
    expect(ScheduledReportsService.dueSchedules(new Date('2026-06-01T06:00:00Z'))).toEqual(['weekly', 'monthly']); // Monday the 1st
    expect(ScheduledReportsService.dueSchedules(new Date('2026-10-14T06:00:00Z'))).toEqual([]);
  });
});

describe('csv helpers', () => {
  it('prefixes spreadsheet-formula text but keeps negative numbers', () => {
    const csv = toCsv(['a', 'b', 'c'], [['=HYPERLINK("x")', '-5.00', '+92300']]);
    expect(csv.split('\n')[1]).toBe(`"'=HYPERLINK(""x"")","-5.00","'+92300"`);
  });

  it('adds a visible note when rows were cut', () => {
    const rows = Array.from({ length: CSV_ROW_LIMIT + 1 }, (_, i) => [i, 'x']);
    const out = limitCsvRows(rows, 2);
    expect(out).toHaveLength(CSV_ROW_LIMIT + 1);
    expect(String(out[out.length - 1][0])).toContain('NOTE: export limited');
    expect(limitCsvRows([[1, 'x']], 2)).toEqual([[1, 'x']]);
  });
});
