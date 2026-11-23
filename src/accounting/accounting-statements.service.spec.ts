/* eslint-disable prettier/prettier */
import ExcelJS from 'exceljs';
import { AccountingStatementsService } from './accounting-statements.service';
import { DEFAULT_ACCOUNTS } from './chart.const';

const q = <T,>(v: T) => ({ select: () => ({ lean: async () => v }), lean: async () => v });

function service(groups: any[]) {
  const db: any = { repositories: {
    storeModel: { findById: () => q({ name: 'Ali Store', timezone: 'Asia/Karachi', country: 'PK' }) },
    storeLocationModel: { find: () => q([{ _id: 'loc1', name: 'Gulberg' }]) },
  } };
  const accounting: any = { requireEnabled: async () => ({ baseCurrency: 'PKR', goLiveDate: new Date('2026-11-01T00:00:00Z') }) };
  const journal: any = { aggregate: jest.fn(async () => groups) };
  const accounts: any = { find: () => q(DEFAULT_ACCOUNTS.map(a => ({ ...a }))) };
  return { svc: new AccountingStatementsService(db, accounting, journal, accounts), journal };
}
const g = (a: string, d: string, debit: number, credit: number, c: string | null, s: string, l: string | null = null) => ({ _id: { a, d, c, l, s }, debitMinor: debit, creditMinor: credit });

describe('AccountingStatementsService', () => {
  const groups = [
    g('sales_pos', '2026-11-10', 0, 100000, 'pos', 'pos_sale', 'loc1'),
    g('cash', '2026-11-10', 100000, 0, 'pos', 'pos_sale', 'loc1'),
    g('sales_online', '2026-12-02', 0, 50000, null, 'order'), // before Phase 3: channel derived
    g('gateway_clearing', '2026-12-02', 50000, 0, null, 'order'),
    g('exp_rent', '2026-12-05', 20000, 0, 'other', 'expense'),
    g('bank', '2026-12-05', 0, 20000, 'other', 'expense'),
  ];

  it('profit and loss by channel and by branch', async () => {
    const { svc } = service(groups);
    const byChannel: any = await svc.profitAndLoss('s1', { from: '2026-11-01', to: '2026-12-31', groupBy: 'channel' });
    expect(byChannel.buckets).toEqual(['online', 'pos', 'other']);
    expect(byChannel.netProfit.values).toEqual({ online: 50000, pos: 100000, other: -20000 });
    const byBranch: any = await svc.profitAndLoss('s1', { from: '2026-11-01', to: '2026-12-31', groupBy: 'location' });
    expect(byBranch.labels).toEqual({ loc1: 'Gulberg', unassigned: 'Not branch-specific' });
    const posOnly: any = await svc.profitAndLoss('s1', { from: '2026-11-01', to: '2026-12-31', channel: 'pos' });
    expect(posOnly.netProfit.total).toBe(100000);
  });

  it('only counts days inside the period, by the store’s calendar', async () => {
    const { svc } = service(groups);
    const nov: any = await svc.profitAndLoss('s1', { from: '2026-11-01', to: '2026-11-30' });
    expect(nov.buckets).toEqual(['2026-11']);
    expect(nov.netProfit.total).toBe(100000);
  });

  it('writes an Excel workbook that opens with the figures in currency units', async () => {
    const { svc } = service(groups);
    const { buffer, fileName } = await svc.excel('s1', 'profit-and-loss', { from: '2026-11-01', to: '2026-12-31' });
    expect(fileName).toBe('profit-and-loss-2026-11-01-to-2026-12-31.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Profit and loss')!;
    const rows: any[][] = [];
    ws.eachRow(r => rows.push((r.values as any[]).slice(1)));
    expect(rows[0][0]).toBe('Ali Store');
    expect(rows.find(r => r[0] === 'Net profit')).toEqual(['Net profit', 1000, 300, 1300]);
  });

  it('rejects an unknown export', async () => {
    const { svc } = service([]);
    await expect(svc.excel('s1', 'nope', {})).rejects.toThrow(/Unknown report/);
  });
});
