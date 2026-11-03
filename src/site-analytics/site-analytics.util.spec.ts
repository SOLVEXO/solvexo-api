/* eslint-disable prettier/prettier */
import { change, consentRequired, dateRanges, isoDay, lastDays, MEASUREMENT_ID_RE, reportRows, reportTotals } from './site-analytics.util';
import { normalizeGa4Property } from '../seo/services/seo-integrations.service';

describe('site analytics helpers', () => {
  it('asks for consent only in the EU, EEA, UK and Switzerland', () => {
    expect(['DE', 'fr', 'GB', 'NO', 'CH'].map(consentRequired)).toEqual([true, true, true, true, true]);
    expect(['PK', 'US', 'AE', null, ''].map(consentRequired)).toEqual([false, false, false, false, false]);
  });

  it('builds the period and the same-length period before it', () => {
    expect(dateRanges('7d')).toEqual({ current: { startDate: '6daysAgo', endDate: 'today' }, previous: { startDate: '13daysAgo', endDate: '7daysAgo' } });
    expect(dateRanges('28d').previous).toEqual({ startDate: '55daysAgo', endDate: '28daysAgo' });
  });

  it('reads GA4 report rows and totals into plain objects', () => {
    const report = {
      dimensionHeaders: [{ name: 'country' }],
      metricHeaders: [{ name: 'totalUsers' }, { name: 'sessions' }],
      rows: [{ dimensionValues: [{ value: 'Pakistan' }], metricValues: [{ value: '120' }, { value: '150' }] }],
      totals: [{ metricValues: [{ value: '130' }, { value: '170' }] }],
    };
    expect(reportRows(report)).toEqual([{ country: 'Pakistan', totalUsers: 120, sessions: 150 }]);
    expect(reportTotals(report)).toEqual({ totalUsers: 130, sessions: 170 });
    expect(reportTotals({ metricHeaders: [{ name: 'totalUsers' }], rows: [{ metricValues: [{ value: '9' }] }] })).toEqual({ totalUsers: 9 });
    expect(reportRows(undefined)).toEqual([]);
  });

  it('formats dates, changes, measurement ids and property ids', () => {
    expect(lastDays(3, new Date('2026-11-03T10:00:00Z'))).toEqual(['20261101', '20261102', '20261103']);
    expect(isoDay('20261103')).toBe('2026-11-03');
    expect([change(150, 100), change(50, 100), change(5, 0)]).toEqual([50, -50, null]);
    expect(['G-AB12CD34EF', 'UA-1234-1', 'g-ab12'].map((v) => MEASUREMENT_ID_RE.test(v))).toEqual([true, false, false]);
    expect([normalizeGa4Property('123456789'), normalizeGa4Property('properties/123456789'), normalizeGa4Property('G-ABC')]).toEqual(['properties/123456789', 'properties/123456789', null]);
  });
});
