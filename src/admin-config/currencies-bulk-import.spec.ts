/* eslint-disable prettier/prettier */
import { runBulkImport } from '../common/bulk-import/bulk-import.util';
import { CURRENCY_COLUMNS, currencyFileDedupeKey, makeCurrencyRowHandler } from './currencies-bulk-import';

describe('currencies bulk import', () => {
  it('adds new currencies, skips enabled, rejects bad codes/bands', async () => {
    const added: any[] = [];
    const handler = makeCurrencyRowHandler({
      listEnabledCodes: async () => ['PKR'],
      addCurrency: async (c, min, max) => { added.push([c, min, max]); },
    });
    const res: any = await runBulkImport({
      text: 'Code,Sanity band min,Sanity band max\neur,0.6,1.3\nPKR,150,450\nUSD,1,2\nQQQ,1,2\nGBP,2,1\nSEK,abc,3\nEUR,1,2\n',
      columns: CURRENCY_COLUMNS, maxRows: 50, label: 'currency', handler, fileDedupeKey: currencyFileDedupeKey,
    });
    expect(res.data.created).toBe(1);
    expect(res.data.skipped).toBe(1);
    expect(res.data.failedCount).toBe(5);
    expect(added).toEqual([['EUR', 0.6, 1.3]]);
    const errs = res.data.failed.map((f: any) => f.error).join('|');
    expect(errs).toContain('USD is always enabled');
    expect(errs).toContain('not a real ISO-4217');
    expect(errs).toContain('greater than');
    expect(errs).toContain('must be a number');
    expect(errs).toContain('Duplicate of row');
  });
});
