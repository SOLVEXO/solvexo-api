/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { isoExponent } from '../common/money-minor.util';
import { GatewaySettlement, GatewaySettlementDocument } from './accounting.schema';
import { AccountingService, type Actor } from './accounting.service';
import { orderAmounts } from './posting-rules.util';
import { detectColumns, matchLine, parseCsv, toLines, type ColumnMap, type SettlementField } from './settlement.util';

/** Gateways a settlement can come from, and the clearing account it empties. Courier COD remittances work the same way. */
export const SETTLEMENT_SOURCES: Record<string, { label: string; clearing: string }> = {
  jazzcash: { label: 'JazzCash', clearing: 'gateway_clearing' },
  easypaisa: { label: 'Easypaisa', clearing: 'gateway_clearing' },
  safepay: { label: 'Safepay', clearing: 'gateway_clearing' },
  payfast: { label: 'PayFast', clearing: 'gateway_clearing' },
  other_gateway: { label: 'Other payment gateway', clearing: 'gateway_clearing' },
  courier_cod: { label: 'Courier cash-on-delivery remittance', clearing: 'cod_receivable' },
};
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
const FIELDS: SettlementField[] = ['date', 'reference', 'gross', 'fee', 'net'];

/**
 * Gateway settlement import (Accounting Plan, Phase 3). The seller uploads the gateway's settlement report; each line is matched to
 * their orders (by the gateway transaction reference Solvexo kept for the payment, or by the order number), they review it, and
 * posting moves the gross out of the clearing account into the bank, with the gateway's fees as processing fees.
 */
@Injectable()
export class AccountingSettlementsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly accounting: AccountingService,
    @InjectModel(GatewaySettlement.name) private readonly model: Model<GatewaySettlementDocument>,
  ) {}
  private get r(): any { return this.db.repositories; }

  /** Reads the file and matches every line; saves a draft for review. `columns` overrides the detected header mapping. */
  async import(storeId: string, body: any, actor: Actor) {
    const s = await this.accounting.requireEnabled(storeId);
    const gateway = String(body?.gateway ?? '');
    if (!SETTLEMENT_SOURCES[gateway]) throw new BadRequestException('Choose which gateway or courier the settlement is from.');
    const csv = typeof body?.csv === 'string' ? body.csv : '';
    if (!csv.trim()) throw new BadRequestException('The settlement file is empty.');
    if (Buffer.byteLength(csv, 'utf8') > MAX_BYTES) throw new BadRequestException('The file is larger than 2 MB; split it by date.');
    const settledOn = new Date(body?.settledOn);
    if (Number.isNaN(settledOn.getTime())) throw new BadRequestException('Enter the date the money reached your bank.');
    if (settledOn < s.goLiveDate) throw new BadRequestException('That date is before your books start.');
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new BadRequestException('The file needs a header row and at least one line.');
    if (rows.length - 1 > MAX_ROWS) throw new BadRequestException(`At most ${MAX_ROWS} lines per file.`);
    const headers = rows[0].map(h => h.trim());
    const map: ColumnMap = { ...detectColumns(headers) };
    for (const f of FIELDS) {
      const v = body?.columns?.[f];
      if (v === null || v === '') delete map[f];
      else if (v !== undefined && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < headers.length) map[f] = Number(v);
    }
    if (map.reference == null) throw new BadRequestException({ message: 'Which column holds the transaction reference or order number?', headers, columns: map });
    if ([map.gross, map.fee, map.net].filter(x => x != null).length < 2 && !(map.gross != null || map.net != null)) {
      throw new BadRequestException({ message: 'Which columns hold the amounts (two of gross, fee and net)?', headers, columns: map });
    }
    const exp = isoExponent(s.baseCurrency);
    const { lines, problems } = toLines(rows.slice(1), map, exp);
    if (!lines.length) throw new BadRequestException({ message: 'No usable lines in the file.', headers, columns: map, problems: problems.slice(0, 20) });

    const matched = await this.match(storeId, lines.map(l => l.reference), s.baseCurrency, exp);
    const posted = new Set<string>((await this.model.find({ storeId, status: 'posted', 'lines.reference': { $in: lines.map(l => l.reference) } }).select('lines.reference').lean()).flatMap(d => d.lines.map(l => l.reference)));
    const seen = new Set<string>();
    const out = lines.map(l => {
      const dup = seen.has(l.reference) || posted.has(l.reference);
      seen.add(l.reference);
      return { ...l, match: matchLine(l.grossMinor, matched.get(l.reference) ?? null, dup, exp) };
    });
    const counted = out.filter(l => l.match.status !== 'duplicate');
    const totals = {
      grossMinor: counted.reduce((t, l) => t + l.grossMinor, 0), feeMinor: counted.reduce((t, l) => t + l.feeMinor, 0), netMinor: counted.reduce((t, l) => t + l.netMinor, 0),
      matched: out.filter(l => l.match.status === 'matched').length, unmatched: out.filter(l => l.match.status !== 'matched').length,
    };
    const doc = await this.model.create({
      storeId, gateway, fileName: String(body?.fileName ?? '').slice(0, 120), settledOn, currency: s.baseCurrency, lines: out, totals, status: 'draft', importedBy: actor.id,
    });
    return { settlement: doc.toObject(), headers, columns: map, problems: problems.slice(0, 50), skippedRows: problems.length };
  }

  /**
   * reference → this store's orders it pays for, and what the books expect for them (the sellerOrders' cash, in base minor units).
   * First the gateway transaction reference Solvexo stored when the payment started, then the order number itself.
   */
  private async match(storeId: string, refs: string[], base: string, exp: number) {
    const out = new Map<string, { orderIds: string[]; orderNumbers: string[]; expectedMinor: number | null }>();
    const uniq = [...new Set(refs)];
    const txs: any[] = await this.r.paymentTransactionModel.find({ providerSessionId: { $in: uniq } }).select('providerSessionId orderIds').lean();
    const byRefIds = new Map<string, string[]>(txs.map(t => [String(t.providerSessionId), (t.orderIds ?? []).map(String)]));
    const ids = [...new Set([...byRefIds.values()].flat())].filter(i => Types.ObjectId.isValid(i));
    const orders: any[] = await this.r.orderModel.find({
      'sellerOrders.storeId': storeId,
      $or: [{ _id: { $in: ids } }, { orderNumber: { $in: uniq } }],
    }).select('orderNumber currency paymentType sellerOrders settledViaConnect').lean();
    const ctx = { base, exp };
    const cashOf = (o: any) => (o.sellerOrders ?? []).filter((so: any) => so.storeId === storeId).reduce((t: number, so: any) => t + (orderAmounts(o, so, ctx)?.cash ?? 0), 0);
    for (const ref of uniq) {
      const viaTx = byRefIds.get(ref);
      const hits = orders.filter(o => (viaTx ? viaTx.includes(String(o._id)) : false) || o.orderNumber === ref);
      if (!hits.length) continue;
      out.set(ref, { orderIds: hits.map(o => String(o._id)), orderNumbers: hits.map(o => o.orderNumber), expectedMinor: hits.reduce((t, o) => t + cashOf(o), 0) });
    }
    return out;
  }

  async list(storeId: string) {
    await this.accounting.requireEnabled(storeId);
    const rows = await this.model.find({ storeId }).sort({ createdAt: -1 }).limit(100).select('-lines').lean();
    return { sources: Object.entries(SETTLEMENT_SOURCES).map(([key, v]) => ({ key, label: v.label })), items: rows };
  }

  async get(storeId: string, id: string) {
    await this.accounting.requireEnabled(storeId);
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Settlement not found');
    const doc = await this.model.findOne({ storeId, _id: id }).lean();
    if (!doc) throw new NotFoundException('Settlement not found');
    return doc;
  }

  /**
   * One entry for the whole settlement: Dr bank (net), Dr processing fees (fee), Cr the clearing account (gross).
   * Lines marked duplicate are left out. Unmatched lines are posted too: the money did arrive; the seller has seen them in the review.
   */
  async post(storeId: string, id: string, actor: Actor) {
    const doc = await this.get(storeId, id);
    if (doc.status !== 'draft') throw new ConflictException(`This settlement is already ${doc.status}.`);
    const t = doc.totals;
    if (!t.grossMinor) throw new BadRequestException('Nothing to post.');
    const src = SETTLEMENT_SOURCES[doc.gateway] ?? SETTLEMENT_SOURCES.other_gateway;
    const entry = await this.accounting.post(storeId, {
      sourceType: 'settlement', sourceId: String(doc._id), sourceKey: `settlement:${doc._id}`, date: new Date(doc.settledOn), channel: 'online',
      reference: doc.fileName || src.label, memo: `${src.label} settlement: ${t.matched} matched, ${t.unmatched} not matched`,
      lines: [
        { accountKey: 'bank', debitMinor: t.netMinor, creditMinor: 0, memo: 'Paid into the bank' },
        { accountKey: 'processing_fees', debitMinor: t.feeMinor, creditMinor: 0, memo: `${src.label} fees` },
        { accountKey: src.clearing, debitMinor: 0, creditMinor: t.grossMinor, memo: 'Settled payments' },
      ],
    }, 'auto', actor.id);
    const claimed = await this.model.updateOne({ storeId, _id: doc._id, status: 'draft' }, { $set: { status: 'posted', journalEntryId: entry ? String(entry._id) : null } });
    if (!claimed.modifiedCount) throw new ConflictException('This settlement was posted by someone else just now.');
    return this.get(storeId, id);
  }

  async discard(storeId: string, id: string) {
    const doc = await this.get(storeId, id);
    if (doc.status !== 'draft') throw new ConflictException('Only a draft can be discarded; reverse the journal entry of a posted settlement.');
    await this.model.updateOne({ storeId, _id: doc._id, status: 'draft' }, { $set: { status: 'discarded' } });
    return this.get(storeId, id);
  }
}
