/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { isoExponent } from '../common/money-minor.util';
import { AccountingSettings, AccountingSettingsDocument, JournalEntry, JournalEntryDocument, LedgerAccount, LedgerAccountDocument } from './accounting.schema';
import { ACCOUNT_TYPES, DEFAULT_ACCOUNTS, isDebitNormal, type AccountType } from './chart.const';
import { finalize, swapped, type DraftLine, type EntryDraft } from './posting-rules.util';
import { openingLines, trialBalance } from './trial-balance.util';

const DAY = 86_400_000;
const parseDate = (v: any, field: string): Date => {
  const d = new Date(v);
  if (v == null || v === '' || Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be a date`);
  return d;
};
const clampInt = (v: any, lo: number, hi: number, dflt: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const str = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export interface Actor { id: string; role: string }

/** The store's books: setup, chart of accounts, posting, reversals and the reports read from the journal. */
@Injectable()
export class AccountingService {
  constructor(
    @InjectModel(LedgerAccount.name) private readonly accounts: Model<LedgerAccountDocument>,
    @InjectModel(AccountingSettings.name) private readonly settingsModel: Model<AccountingSettingsDocument>,
    @InjectModel(JournalEntry.name) private readonly journal: Model<JournalEntryDocument>,
  ) {}

  // ── Setup ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  async settings(storeId: string) {
    const s = await this.settingsModel.findOne({ storeId }).lean();
    return s ?? null;
  }

  async requireEnabled(storeId: string) {
    const s = await this.settings(storeId);
    if (!s?.enabled) throw new BadRequestException('Accounting is not turned on for this store yet.');
    return s;
  }

  /** Turns accounting on (or moves the go-live date while nothing automatic has posted yet) and seeds the default chart. */
  async setup(storeId: string, store: any, body: any, actor: Actor) {
    const goLive = parseDate(body?.goLiveDate, 'goLiveDate');
    const day = new Date(Date.UTC(goLive.getUTCFullYear(), goLive.getUTCMonth(), goLive.getUTCDate()));
    if (day.getTime() > Date.now() + 366 * DAY) throw new BadRequestException('The go-live date must be within the next year.');
    const existing = await this.settingsModel.findOne({ storeId });
    if (existing?.enabled) {
      if (existing.goLiveDate.getTime() !== day.getTime()) {
        const posted = await this.journal.countDocuments({ storeId, kind: { $in: ['auto', 'manual'] } });
        if (posted > 0) throw new ConflictException('The go-live date cannot change once entries have been posted.');
        existing.goLiveDate = day;
        existing.cursors = {};
        existing.markModified('cursors');
        await existing.save();
      }
      return this.settings(storeId);
    }
    const baseCurrency = String(store?.baseCurrency || 'PKR').toUpperCase();
    await this.settingsModel.updateOne(
      { storeId },
      { $set: { enabled: true, goLiveDate: day, enabledBy: actor.id, cursors: {} }, $setOnInsert: { storeId, baseCurrency, entrySeq: 0 } },
      { upsert: true },
    );
    await this.seedAccounts(storeId);
    return this.settings(storeId);
  }

  private async seedAccounts(storeId: string) {
    const have = new Set((await this.accounts.find({ storeId }).select('key').lean()).map(a => a.key));
    const missing = DEFAULT_ACCOUNTS.filter(a => !have.has(a.key));
    if (!missing.length) return;
    try {
      await this.accounts.insertMany(missing.map(a => ({ storeId, ...a, system: true })), { ordered: false });
    } catch (e: any) {
      // A code the seller already used for a custom account: seed that one with a free code instead.
      if (e?.code !== 11000 && !e?.writeErrors) throw e;
      for (const a of missing) {
        if (await this.accounts.exists({ storeId, key: a.key })) continue;
        await this.accounts.create({ storeId, ...a, code: await this.freeCode(storeId, a.code), system: true });
      }
    }
  }

  private async freeCode(storeId: string, code: string) {
    for (let i = 1; i < 100; i++) { const c = `${code}-${i}`; if (!(await this.accounts.exists({ storeId, code: c }))) return c; }
    return `${code}-${randomBytes(2).toString('hex')}`;
  }

  // ── Chart of accounts ───────────────────────────────────────────────────────────────────────────────────────────────

  async listAccounts(storeId: string) {
    await this.requireEnabled(storeId);
    const [rows, sums] = await Promise.all([this.accounts.find({ storeId }).lean(), this.sums(storeId)]);
    const tb = trialBalance(rows.map(r => ({ key: r.key, code: r.code, name: r.name, type: r.type as AccountType, group: r.group, archived: r.archived })), sums, true);
    const meta = new Map(rows.map(r => [r.key, r]));
    return tb.rows.map(r => ({ ...r, system: !!meta.get(r.key)?.system, externalCode: meta.get(r.key)?.externalCode ?? null, archived: !!meta.get(r.key)?.archived }));
  }

  async createAccount(storeId: string, body: any) {
    await this.requireEnabled(storeId);
    const code = str(body?.code, 20), name = str(body?.name, 120);
    if (!code || !name) throw new BadRequestException('An account needs a code and a name.');
    if (!(ACCOUNT_TYPES as readonly string[]).includes(body?.type)) throw new BadRequestException(`Type must be one of ${ACCOUNT_TYPES.join(', ')}.`);
    if (await this.accounts.exists({ storeId, code })) throw new ConflictException(`Code ${code} is already used.`);
    const doc = await this.accounts.create({ storeId, key: `x_${randomBytes(5).toString('hex')}`, code, name, type: body.type, group: str(body?.group, 60), externalCode: str(body?.externalCode, 120) || null, system: false });
    return doc.toObject();
  }

  async updateAccount(storeId: string, key: string, body: any) {
    await this.requireEnabled(storeId);
    const acc = await this.accounts.findOne({ storeId, key });
    if (!acc) throw new NotFoundException('Account not found');
    if (body?.code !== undefined) {
      const code = str(body.code, 20);
      if (!code) throw new BadRequestException('Code cannot be empty.');
      if (code !== acc.code && (await this.accounts.exists({ storeId, code }))) throw new ConflictException(`Code ${code} is already used.`);
      acc.code = code;
    }
    if (body?.name !== undefined) { const n = str(body.name, 120); if (!n) throw new BadRequestException('Name cannot be empty.'); acc.name = n; }
    if (body?.group !== undefined) acc.group = str(body.group, 60);
    if (body?.externalCode !== undefined) acc.externalCode = str(body.externalCode, 120) || null;
    if (body?.type !== undefined && body.type !== acc.type) {
      if (acc.system) throw new BadRequestException("A default account's type cannot change.");
      if (!(ACCOUNT_TYPES as readonly string[]).includes(body.type)) throw new BadRequestException('Unknown account type.');
      if (await this.journal.exists({ storeId, 'lines.accountKey': key })) throw new BadRequestException('This account already has entries; its type cannot change.');
      acc.type = body.type;
    }
    if (body?.archived !== undefined) {
      if (body.archived && acc.system) throw new BadRequestException('Default accounts cannot be archived: automatic entries use them.');
      if (body.archived) {
        const s = (await this.sums(storeId, { accountKey: key }))[0];
        if (s && s.debitMinor !== s.creditMinor) throw new BadRequestException('Only an account with a zero balance can be archived.');
      }
      acc.archived = !!body.archived;
    }
    await acc.save();
    return acc.toObject();
  }

  private async accountMap(storeId: string) {
    return new Map((await this.accounts.find({ storeId }).lean()).map(a => [a.key, a]));
  }

  // ── Posting ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Writes one balanced entry. Returns null when an entry with the same source key already exists (idempotent). */
  async post(storeId: string, draft: EntryDraft, kind: 'auto' | 'manual' | 'opening' | 'reversal', actorId = '', reversesEntryId: string | null = null) {
    const d = finalize(draft);
    if (!d.lines.length) return null;
    if (await this.journal.exists({ storeId, sourceKey: d.sourceKey })) return null;
    const s = await this.settingsModel.findOneAndUpdate({ storeId, enabled: true }, { $inc: { entrySeq: 1 } }, { new: true }).lean();
    if (!s) throw new BadRequestException('Accounting is not turned on for this store.');
    try {
      const doc = await this.journal.create({
        storeId, seq: s.entrySeq, date: d.date, kind, sourceType: d.sourceType, sourceId: d.sourceId, sourceKey: d.sourceKey,
        reference: d.reference.slice(0, 80), memo: d.memo.slice(0, 300), lines: d.lines.map(l => ({ ...l, memo: (l.memo ?? '').slice(0, 200) })),
        totalMinor: d.lines.reduce((t, l) => t + l.debitMinor, 0), currency: s.baseCurrency, reversesEntryId, actorId,
        channel: d.channel ?? null, locationId: d.locationId ?? null,
      });
      return doc.toObject();
    } catch (e: any) {
      if (e?.code === 11000) return null; // posted by a concurrent run
      throw e;
    }
  }

  /** Posts the mirror image of an entry, dated `date` (default: today). An entry can be reversed once; a reversal cannot be reversed. */
  async reverse(storeId: string, entryId: string, actor: Actor, memo = '', date?: Date) {
    const e = await this.journal.findOne({ storeId, _id: entryId }).lean();
    if (!e) throw new NotFoundException('Entry not found');
    if (e.kind === 'reversal') throw new BadRequestException('A reversal cannot itself be reversed; post a new entry instead.');
    if (await this.journal.exists({ storeId, reversesEntryId: String(e._id) })) throw new ConflictException('This entry has already been reversed.');
    const posted = await this.post(storeId, {
      sourceType: e.sourceType, sourceId: e.sourceId ?? String(e._id), sourceKey: `reverse:${e._id}`, date: date ?? new Date(),
      reference: e.reference, memo: (memo ? `Reversal of #${e.seq}: ${memo}` : `Reversal of #${e.seq}`), lines: swapped(e.lines as DraftLine[]),
      channel: (e.channel ?? undefined) as any, locationId: e.locationId ?? null,
    }, 'reversal', actor.id, String(e._id));
    if (!posted) throw new ConflictException('This entry has already been reversed.');
    return posted;
  }

  private async validateLines(storeId: string, raw: any): Promise<DraftLine[]> {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw new BadRequestException('Give between 1 and 100 lines.');
    const map = await this.accountMap(storeId);
    return raw.map((l: any, i: number) => {
      const acc = map.get(String(l?.accountKey ?? ''));
      if (!acc) throw new BadRequestException(`Line ${i + 1}: unknown account.`);
      if (acc.archived) throw new BadRequestException(`Line ${i + 1}: ${acc.name} is archived.`);
      const debitMinor = Math.round(Number(l?.debitMinor) || 0), creditMinor = Math.round(Number(l?.creditMinor) || 0);
      if (debitMinor < 0 || creditMinor < 0 || !Number.isSafeInteger(debitMinor) || !Number.isSafeInteger(creditMinor)) throw new BadRequestException(`Line ${i + 1}: amounts must be positive whole minor units.`);
      if ((debitMinor > 0) === (creditMinor > 0)) throw new BadRequestException(`Line ${i + 1}: enter either a debit or a credit.`);
      return { accountKey: acc.key, debitMinor, creditMinor, memo: str(l?.memo, 200) };
    });
  }

  /** A journal entry written by hand (accounting.manage). Dated on or after the go-live date. */
  async manualEntry(storeId: string, body: any, actor: Actor) {
    const s = await this.requireEnabled(storeId);
    const date = parseDate(body?.date, 'date');
    if (date < s.goLiveDate) throw new BadRequestException('Entries before the go-live date belong in the opening balances.');
    const lines = await this.validateLines(storeId, body?.lines);
    if (lines.length < 2) throw new BadRequestException('An entry needs at least two lines.');
    const debit = lines.reduce((t, l) => t + l.debitMinor, 0), credit = lines.reduce((t, l) => t + l.creditMinor, 0);
    if (debit !== credit) throw new BadRequestException(`Debits (${debit}) and credits (${credit}) must be equal.`);
    const id = randomBytes(8).toString('hex');
    return this.post(storeId, { sourceType: 'manual', sourceId: id, sourceKey: `manual:${id}`, date, reference: str(body?.reference, 80), memo: str(body?.memo, 300) || 'Journal entry', lines }, 'manual', actor.id);
  }

  /** Replaces the opening balances: the previous opening entry is reversed, the new one posted on the go-live date. */
  async setOpeningBalances(storeId: string, body: any, actor: Actor) {
    const s = await this.requireEnabled(storeId);
    const input = await this.validateLines(storeId, (body?.lines ?? []).filter((l: any) => Number(l?.debitMinor) || Number(l?.creditMinor)));
    if (s.openingEntryId && !(await this.journal.exists({ storeId, reversesEntryId: s.openingEntryId }))) {
      await this.reverse(storeId, s.openingEntryId, actor, 'opening balances replaced', s.goLiveDate);
    }
    const { lines, suspenseMinor } = openingLines(input);
    const n = await this.journal.countDocuments({ storeId, kind: 'opening' });
    const posted = await this.post(storeId, {
      sourceType: 'opening', sourceId: storeId, sourceKey: `opening:${n + 1}`, date: s.goLiveDate, reference: '', memo: 'Opening balances', lines,
    }, 'opening', actor.id);
    await this.settingsModel.updateOne({ storeId }, { $set: { openingEntryId: posted ? String(posted._id) : null } });
    return { entry: posted, suspenseMinor };
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Debit and credit totals per account (optionally up to a date, from a date, or for one account). */
  async sums(storeId: string, f: { from?: Date; to?: Date; accountKey?: string } = {}) {
    const match: any = { storeId };
    if (f.from || f.to) match.date = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
    if (f.accountKey) match['lines.accountKey'] = f.accountKey;
    const rows = await this.journal.aggregate([
      { $match: match }, { $unwind: '$lines' }, ...(f.accountKey ? [{ $match: { 'lines.accountKey': f.accountKey } }] : []),
      { $group: { _id: '$lines.accountKey', debitMinor: { $sum: '$lines.debitMinor' }, creditMinor: { $sum: '$lines.creditMinor' } } },
    ]);
    return rows.map((r: any) => ({ accountKey: r._id, debitMinor: r.debitMinor, creditMinor: r.creditMinor }));
  }

  async trialBalance(storeId: string, q: any) {
    const s = await this.requireEnabled(storeId);
    const asOf = q?.asOf ? parseDate(q.asOf, 'asOf') : new Date();
    const to = new Date(asOf.getTime() + DAY - 1); // the whole as-of day
    const accounts = (await this.accounts.find({ storeId }).lean()).map(a => ({ key: a.key, code: a.code, name: a.name, type: a.type as AccountType, group: a.group, archived: a.archived }));
    return { asOf, currency: s.baseCurrency, exponent: isoExponent(s.baseCurrency), ...trialBalance(accounts, await this.sums(storeId, { to })) };
  }

  async journalList(storeId: string, q: any) {
    const s = await this.requireEnabled(storeId);
    const filter: any = { storeId };
    if (q?.from || q?.to) filter.date = { ...(q.from ? { $gte: parseDate(q.from, 'from') } : {}), ...(q.to ? { $lte: new Date(parseDate(q.to, 'to').getTime() + DAY - 1) } : {}) };
    if (q?.sourceType) filter.sourceType = String(q.sourceType);
    if (q?.accountKey) filter['lines.accountKey'] = String(q.accountKey);
    if (q?.q) { const rx = new RegExp(String(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60), 'i'); filter.$or = [{ reference: rx }, { memo: rx }]; }
    const limit = clampInt(q?.limit, 1, 200, 50), page = clampInt(q?.page, 1, 10_000, 1);
    const [items, total] = await Promise.all([
      this.journal.find(filter).sort({ date: -1, seq: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.journal.countDocuments(filter),
    ]);
    const reversed = new Set((await this.journal.find({ storeId, reversesEntryId: { $in: items.map(i => String(i._id)) } }).select('reversesEntryId').lean()).map(r => r.reversesEntryId));
    return { currency: s.baseCurrency, exponent: isoExponent(s.baseCurrency), total, page, limit, items: items.map(i => ({ ...i, reversed: reversed.has(String(i._id)) })) };
  }

  async entry(storeId: string, id: string) {
    await this.requireEnabled(storeId);
    const e = await this.journal.findOne({ storeId, _id: id }).lean();
    if (!e) throw new NotFoundException('Entry not found');
    const reversal = await this.journal.findOne({ storeId, reversesEntryId: String(e._id) }).select('_id seq date').lean();
    return { ...e, reversal: reversal ?? null };
  }

  /** One account's lines with a running balance; `opening` is its balance before `from`. */
  async accountLedger(storeId: string, key: string, q: any) {
    const s = await this.requireEnabled(storeId);
    const acc = await this.accounts.findOne({ storeId, key }).lean();
    if (!acc) throw new NotFoundException('Account not found');
    const from = q?.from ? parseDate(q.from, 'from') : s.goLiveDate;
    const to = q?.to ? new Date(parseDate(q.to, 'to').getTime() + DAY - 1) : new Date();
    const sign = isDebitNormal(acc.type as AccountType) ? 1 : -1;
    const before = (await this.sums(storeId, { to: new Date(from.getTime() - 1), accountKey: key }))[0];
    let running = before ? sign * (before.debitMinor - before.creditMinor) : 0;
    const opening = running;
    const limit = clampInt(q?.limit, 1, 1000, 500);
    const entries = await this.journal.find({ storeId, 'lines.accountKey': key, date: { $gte: from, $lte: to } }).sort({ date: 1, seq: 1 }).limit(limit).lean();
    const lines = entries.flatMap(e => e.lines.filter(l => l.accountKey === key).map(l => {
      running += sign * (l.debitMinor - l.creditMinor);
      return { entryId: String(e._id), seq: e.seq, date: e.date, sourceType: e.sourceType, sourceId: e.sourceId, reference: e.reference, memo: l.memo || e.memo, debitMinor: l.debitMinor, creditMinor: l.creditMinor, balanceMinor: running };
    }));
    return { account: acc, currency: s.baseCurrency, exponent: isoExponent(s.baseCurrency), from, to, opening, closing: running, lines, truncated: entries.length === limit };
  }

  /** Every debit equals every credit, across the whole journal. */
  async check(storeId: string) {
    const [r] = await this.journal.aggregate([{ $match: { storeId } }, { $unwind: '$lines' }, { $group: { _id: null, d: { $sum: '$lines.debitMinor' }, c: { $sum: '$lines.creditMinor' } } }]);
    const entries = await this.journal.countDocuments({ storeId });
    const lastCheck = { at: new Date(), ok: (r?.d ?? 0) === (r?.c ?? 0), debitMinor: r?.d ?? 0, creditMinor: r?.c ?? 0, entries };
    await this.settingsModel.updateOne({ storeId }, { $set: { lastCheck } });
    return lastCheck;
  }
}
