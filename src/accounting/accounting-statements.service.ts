/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import ExcelJS from 'exceljs';
import { DatabaseService } from '../database/databaseservice';
import { isoExponent } from '../common/money-minor.util';
import { resolveStoreTimeZone } from '../common/store-timezone.util';
import { JournalEntry, JournalEntryDocument, LedgerAccount, LedgerAccountDocument } from './accounting.schema';
import { AccountingService } from './accounting.service';
import type { AccountType } from './chart.const';
import { CHANNEL_LABEL, balanceSheet, channelOf, monthsBetween, profitAndLoss, salesTaxSummary, type MovementRow, type StatementAccount } from './statements.util';

export type GroupBy = 'month' | 'channel' | 'location';
const GROUPS: GroupBy[] = ['month', 'channel', 'location'];
const DAY = 86_400_000;
const isDay = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Profit & loss, balance sheet and the sales tax summary from the journal, by month, channel or branch; each also as an Excel file. */
@Injectable()
export class AccountingStatementsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly accounting: AccountingService,
    @InjectModel(JournalEntry.name) private readonly journal: Model<JournalEntryDocument>,
    @InjectModel(LedgerAccount.name) private readonly accountModel: Model<LedgerAccountDocument>,
  ) {}

  private async accounts(storeId: string): Promise<StatementAccount[]> {
    return (await this.accountModel.find({ storeId }).lean()).map(a => ({ key: a.key, code: a.code, name: a.name, type: a.type as AccountType, group: a.group }));
  }

  private async tz(storeId: string) {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('timezone country').lean();
    return resolveStoreTimeZone(store);
  }

  /** The period: whole days in the store's time zone, `from` defaulting to the go-live date and `to` to today. */
  private period(q: any, goLive: Date, tz: string) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const from = isDay(q?.from) ? q.from : new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(goLive);
    const to = isDay(q?.to) ? q.to : today;
    if (to < from) throw new BadRequestException('The end of the period is before its start.');
    // Wide UTC bounds (±14 h covers every zone); the exact local-day filter is applied on the local date string below.
    return { from, to, start: new Date(Date.parse(`${from}T00:00:00Z`) - 14 * 3_600_000), end: new Date(Date.parse(`${to}T00:00:00Z`) + DAY + 14 * 3_600_000) };
  }

  /** Movement per account, local day, channel, branch and source over a period (journal lines unwound). */
  private async movement(storeId: string, start: Date, end: Date, tz: string, accountKeys?: string[]) {
    const rows: any[] = await this.journal.aggregate([
      { $match: { storeId, date: { $gte: start, $lt: end } } },
      { $unwind: '$lines' },
      ...(accountKeys ? [{ $match: { 'lines.accountKey': { $in: accountKeys } } }] : []),
      { $group: {
        _id: { a: '$lines.accountKey', d: { $dateToString: { date: '$date', format: '%Y-%m-%d', timezone: tz } }, c: '$channel', l: '$locationId', s: '$sourceType' },
        debitMinor: { $sum: '$lines.debitMinor' }, creditMinor: { $sum: '$lines.creditMinor' },
      } },
    ]);
    return rows.map(r => ({ accountKey: r._id.a as string, day: r._id.d as string, channel: channelOf(r._id.s, r._id.c), locationId: (r._id.l as string | null) ?? null, debitMinor: r.debitMinor as number, creditMinor: r.creditMinor as number }));
  }

  private async locationNames(storeId: string) {
    const rows: any[] = await this.db.repositories.storeLocationModel.find({ storeId }).select('name').lean();
    return new Map<string, string>(rows.map(r => [String(r._id), r.name]));
  }

  async profitAndLoss(storeId: string, q: any) {
    const s = await this.accounting.requireEnabled(storeId);
    const groupBy: GroupBy = GROUPS.includes(q?.groupBy) ? q.groupBy : 'month';
    const tz = await this.tz(storeId);
    const p = this.period(q, s.goLiveDate, tz);
    if (groupBy === 'month' && monthsBetween(p.from, p.to).length > 24) throw new BadRequestException('Show at most 24 months at a time.');
    let mv = (await this.movement(storeId, p.start, p.end, tz)).filter(r => r.day >= p.from && r.day <= p.to);
    if (q?.channel) mv = mv.filter(r => r.channel === q.channel);
    if (q?.locationId) mv = mv.filter(r => (r.locationId ?? 'unassigned') === q.locationId);
    const names = await this.locationNames(storeId);
    const bucketOf = (r: (typeof mv)[number]) => (groupBy === 'month' ? r.day.slice(0, 7) : groupBy === 'channel' ? r.channel : r.locationId ?? 'unassigned');
    const rows: MovementRow[] = mv.map(r => ({ accountKey: r.accountKey, bucket: bucketOf(r), debitMinor: r.debitMinor, creditMinor: r.creditMinor }));
    const buckets = groupBy === 'month' ? monthsBetween(p.from, p.to) : [...new Set(rows.map(r => r.bucket))].sort((a, b) => (a === 'unassigned' || a === 'other' ? 1 : b === 'unassigned' || b === 'other' ? -1 : a.localeCompare(b)));
    const labels = Object.fromEntries(buckets.map(b => [b, groupBy === 'month' ? b : groupBy === 'channel' ? (CHANNEL_LABEL[b] ?? b) : b === 'unassigned' ? 'Not branch-specific' : (names.get(b) ?? 'Branch')]));
    return {
      currency: s.baseCurrency, exponent: isoExponent(s.baseCurrency), timeZone: tz, from: p.from, to: p.to, groupBy, labels,
      filters: { channel: q?.channel ?? null, locationId: q?.locationId ?? null }, locations: [...names].map(([id, name]) => ({ id, name })),
      ...profitAndLoss(await this.accounts(storeId), rows, buckets),
    };
  }

  async balanceSheet(storeId: string, q: any) {
    const s = await this.accounting.requireEnabled(storeId);
    const tz = await this.tz(storeId);
    const asOf = isDay(q?.asOf) ? q.asOf : new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    // Everything up to the end of the as-of day in the store's time zone.
    const mv = (await this.movement(storeId, new Date(0), new Date(Date.parse(`${asOf}T00:00:00Z`) + DAY + 14 * 3_600_000), tz)).filter(r => r.day <= asOf);
    const sums = new Map<string, { accountKey: string; debitMinor: number; creditMinor: number }>();
    for (const r of mv) { const x = sums.get(r.accountKey) ?? { accountKey: r.accountKey, debitMinor: 0, creditMinor: 0 }; x.debitMinor += r.debitMinor; x.creditMinor += r.creditMinor; sums.set(r.accountKey, x); }
    return { currency: s.baseCurrency, exponent: isoExponent(s.baseCurrency), timeZone: tz, asOf, ...balanceSheet(await this.accounts(storeId), [...sums.values()]) };
  }

  async salesTax(storeId: string, q: any) {
    const s = await this.accounting.requireEnabled(storeId);
    const tz = await this.tz(storeId);
    const p = this.period(q, s.goLiveDate, tz);
    const months = monthsBetween(p.from, p.to);
    if (months.length > 24) throw new BadRequestException('Show at most 24 months at a time.');
    const mv = (await this.movement(storeId, p.start, p.end, tz, ['output_tax', 'input_tax'])).filter(r => r.day >= p.from && r.day <= p.to);
    const rows: MovementRow[] = mv.map(r => ({ accountKey: r.accountKey, bucket: r.day.slice(0, 7), debitMinor: r.debitMinor, creditMinor: r.creditMinor }));
    return {
      currency: s.baseCurrency, exponent: isoExponent(s.baseCurrency), timeZone: tz, from: p.from, to: p.to, ...salesTaxSummary(rows, months),
      note: 'A working paper for your accountant, from the tax posted in the books. Input tax appears once supplier bills with tax are entered (as journal entries for now). It is not a filed return.',
    };
  }

  // ── Excel ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  async excel(storeId: string, kind: string, q: any): Promise<{ buffer: Buffer; fileName: string }> {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('storeName name').lean();
    const storeName = String(store?.storeName ?? store?.name ?? 'Store');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Solvexo';
    wb.created = new Date();
    let fileName: string;
    if (kind === 'profit-and-loss') {
      const r = await this.profitAndLoss(storeId, q);
      fileName = `profit-and-loss-${r.from}-to-${r.to}.xlsx`;
      const fmt = numFmt(r.exponent);
      const ws = wb.addWorksheet('Profit and loss');
      header(ws, storeName, `Profit and loss, ${r.from} to ${r.to} (${r.currency})`, r.buckets.length + 2);
      const head = ws.addRow(['Account', ...r.buckets.map(b => r.labels[b]), 'Total']); head.font = { bold: true };
      const money = (n: number) => n / 10 ** r.exponent;
      for (const sec of r.sections) {
        if (!sec.lines.length) continue;
        ws.addRow([sec.title]).font = { bold: true };
        for (const l of sec.lines) ws.addRow([`${l.code} ${l.name}`, ...r.buckets.map(b => money(l.values[b])), money(l.total)]);
        const t = ws.addRow([`Total ${sec.title.toLowerCase()}`, ...r.buckets.map(b => money(sec.values[b])), money(sec.total)]); t.font = { bold: true };
        if (sec.id === 'cost_of_sales') { const g = ws.addRow(['Gross profit', ...r.buckets.map(b => money(r.grossProfit.values[b])), money(r.grossProfit.total)]); g.font = { bold: true }; }
      }
      const n = ws.addRow(['Net profit', ...r.buckets.map(b => money(r.netProfit.values[b])), money(r.netProfit.total)]); n.font = { bold: true };
      finish(ws, fmt, 2, r.buckets.length + 2);
    } else if (kind === 'balance-sheet') {
      const r = await this.balanceSheet(storeId, q);
      fileName = `balance-sheet-${r.asOf}.xlsx`;
      const ws = wb.addWorksheet('Balance sheet');
      header(ws, storeName, `Balance sheet as of ${r.asOf} (${r.currency})`, 2);
      const money = (n: number) => n / 10 ** r.exponent;
      const block = (title: string, lines: Array<{ code: string; name: string; balanceMinor: number }>, total: number, extra?: [string, number]) => {
        ws.addRow([title]).font = { bold: true };
        for (const l of lines) ws.addRow([`${l.code} ${l.name}`, money(l.balanceMinor)]);
        if (extra) ws.addRow([extra[0], money(extra[1])]);
        ws.addRow([`Total ${title.toLowerCase()}`, money(total)]).font = { bold: true };
        ws.addRow([]);
      };
      block('Assets', r.assets, r.totals.assetsMinor);
      block('Liabilities', r.liabilities, r.totals.liabilitiesMinor);
      block('Equity', r.equity, r.totals.equityMinor, ['Profit for the period (not yet closed)', r.currentProfitMinor]);
      ws.addRow(['Liabilities and equity', money(r.totals.liabilitiesMinor + r.totals.equityMinor)]).font = { bold: true };
      finish(ws, numFmt(r.exponent), 2, 2);
    } else if (kind === 'sales-tax') {
      const r = await this.salesTax(storeId, q);
      fileName = `sales-tax-${r.from}-to-${r.to}.xlsx`;
      const ws = wb.addWorksheet('Sales tax');
      header(ws, storeName, `Sales tax summary, ${r.from} to ${r.to} (${r.currency})`, 4);
      ws.addRow(['Month', 'Output tax (on sales)', 'Input tax (on purchases)', 'Payable']).font = { bold: true };
      const money = (n: number) => n / 10 ** r.exponent;
      for (const m of r.months) ws.addRow([m.month, money(m.outputMinor), money(m.inputMinor), money(m.payableMinor)]);
      ws.addRow(['Total', money(r.totals.outputMinor), money(r.totals.inputMinor), money(r.totals.payableMinor)]).font = { bold: true };
      ws.addRow([]); ws.addRow([r.note]);
      finish(ws, numFmt(r.exponent), 2, 4);
    } else if (kind === 'trial-balance') {
      const r = await this.accounting.trialBalance(storeId, q);
      fileName = `trial-balance-${new Date(r.asOf).toISOString().slice(0, 10)}.xlsx`;
      const ws = wb.addWorksheet('Trial balance');
      header(ws, storeName, `Trial balance as of ${new Date(r.asOf).toISOString().slice(0, 10)} (${r.currency})`, 4);
      ws.addRow(['Code', 'Account', 'Debit', 'Credit']).font = { bold: true };
      const money = (n: number) => n / 10 ** r.exponent;
      for (const row of r.rows) {
        if (!row.balanceMinor) continue;
        const debitSide = (row.type === 'asset' || row.type === 'expense') ? row.balanceMinor >= 0 : row.balanceMinor < 0;
        ws.addRow([row.code, row.name, debitSide ? money(Math.abs(row.balanceMinor)) : null, debitSide ? null : money(Math.abs(row.balanceMinor))]);
      }
      ws.addRow(['', 'Totals', money(r.totals.debitMinor), money(r.totals.creditMinor)]).font = { bold: true };
      finish(ws, numFmt(r.exponent), 3, 4);
    } else throw new BadRequestException('Unknown report.');
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, fileName };
  }
}

const numFmt = (exp: number) => (exp > 0 ? `#,##0.${'0'.repeat(exp)};[Red]-#,##0.${'0'.repeat(exp)}` : '#,##0;[Red]-#,##0');
function header(ws: ExcelJS.Worksheet, store: string, title: string, cols: number) {
  ws.addRow([store]).font = { bold: true, size: 14 };
  ws.addRow([title]).font = { size: 12 };
  ws.addRow([`Prepared by Solvexo on ${new Date().toISOString().slice(0, 10)}`]).font = { italic: true, color: { argb: 'FF777777' } };
  ws.addRow([]);
  ws.columns = Array.from({ length: cols }, (_, i) => ({ width: i === 0 ? 42 : 16 }));
}
function finish(ws: ExcelJS.Worksheet, fmt: string, firstMoneyCol: number, lastCol: number) {
  for (let c = firstMoneyCol; c <= lastCol; c++) ws.getColumn(c).numFmt = fmt;
  ws.views = [{ state: 'frozen', ySplit: 5 }];
}
