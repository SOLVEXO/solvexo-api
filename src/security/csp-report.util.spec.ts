import { parseCspReports } from './csp-report.util';

describe('parseCspReports', () => {
  it('reads the legacy report-uri shape, keeping only hosts and paths', () => {
    const v = parseCspReports({ 'csp-report': {
      'document-uri': 'https://www.solvexo.store/pricing?utm_source=x', 'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example.com/a.js?token=secret', disposition: 'report',
    } });
    expect(v).toEqual([{ directive: 'script-src-elem', blocked: 'evil.example.com', page: 'www.solvexo.store/pricing', disposition: 'report' }]);
  });

  it('reads the Reporting API shape and inline blocks', () => {
    const v = parseCspReports([{ type: 'csp-violation', body: { documentURL: 'https://shop.solvexo.store/', effectiveDirective: 'script-src', blockedURL: 'inline', disposition: 'enforce' } }]);
    expect(v).toEqual([{ directive: 'script-src', blocked: 'inline', page: 'shop.solvexo.store/', disposition: 'enforce' }]);
  });

  it('ignores junk', () => {
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports({ hello: 1 })).toEqual([]);
    expect(parseCspReports(Array(50).fill({ body: { effectiveDirective: 'img-src' } }))).toHaveLength(20);
  });
});
