/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { decryptCredential, encryptCredential, maskSecret } from '../common/credential-encryption.util';
import { assertPublicHost } from '../common/link-preview.util';
import { isoExponent } from '../common/money-minor.util';
import { resolveStoreTimeZone } from '../common/store-timezone.util';
import {
  AccountingConnection, AccountingConnectionDocument, AccountingExportLog, AccountingExportLogDocument, INTEGRATION_APPS, JournalEntry, JournalEntryDocument,
  LedgerAccount, LedgerAccountDocument,
} from './accounting.schema';
import { AccountingService, type Actor } from './accounting.service';
import type { AccountType } from './chart.const';
import { cleanBaseUrl, erpnextJournal, externalRef, localDay, odooMove, summarizeByDay, tallyXml, unmappedAccounts, type IntAccount, type IntEntry } from './integrations.util';

type App = (typeof INTEGRATION_APPS)[number];
type FetchFn = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;
const MAX_ATTEMPTS = 5;
const PER_RUN = 100;
const DAY = 86_400_000;
const isDay = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A failure the seller can act on (wrong key, unmapped account); shown in the sync log as is. */
class AppError extends Error {}

/**
 * Accounting app integrations (Accounting Plan, Phase 4): a Tally import file, and automatic sync to Odoo and ERPNext. All read the
 * same journal. Pushed entries carry `SOLVEXO-<entry number>` as their reference, and each push first looks that reference up in
 * the app, so a retry after a timeout never posts twice.
 */
@Injectable()
export class AccountingIntegrationsService {
  private readonly logger = new Logger(AccountingIntegrationsService.name);
  /** Replaced in tests. Every call: https only, the host checked to be public, no redirects, 20 s timeout. */
  fetchFn: FetchFn = (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) }) as any;
  checkHost: (host: string) => Promise<void> = assertPublicHost;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly accounting: AccountingService,
    @InjectModel(AccountingConnection.name) private readonly connections: Model<AccountingConnectionDocument>,
    @InjectModel(AccountingExportLog.name) private readonly logs: Model<AccountingExportLogDocument>,
    @InjectModel(JournalEntry.name) private readonly journal: Model<JournalEntryDocument>,
    @InjectModel(LedgerAccount.name) private readonly accountModel: Model<LedgerAccountDocument>,
  ) {}

  private async accounts(storeId: string): Promise<IntAccount[]> {
    return (await this.accountModel.find({ storeId }).lean()).map(a => ({ key: a.key, code: a.code, name: a.name, type: a.type as AccountType, group: a.group, externalCode: a.externalCode ?? null }));
  }
  private async store(storeId: string) {
    return (await this.db.repositories.storeModel.findById(storeId).select('name storeName timezone country').lean()) as any;
  }
  private toInt = (e: any): IntEntry => ({ id: String(e._id), seq: e.seq, date: e.date, reference: e.reference ?? '', memo: e.memo ?? '', lines: e.lines });

  // ── Tally ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The Tally import file for a period. Summary (one voucher a day) by default; `mode=detail` gives one voucher per entry. */
  async tallyExport(storeId: string, q: any) {
    const s = await this.accounting.requireEnabled(storeId);
    const store = await this.store(storeId);
    const tz = resolveStoreTimeZone(store);
    const today = localDay(new Date(), tz);
    const from = isDay(q?.from) ? q.from : localDay(s.goLiveDate, tz);
    const to = isDay(q?.to) ? q.to : today;
    if (to < from) throw new BadRequestException('The end of the period is before its start.');
    if (Date.parse(to) - Date.parse(from) > 400 * DAY) throw new BadRequestException('Export at most a year at a time.');
    const rows = await this.journal.find({ storeId, date: { $gte: new Date(Date.parse(`${from}T00:00:00Z`) - 14 * 3_600_000), $lt: new Date(Date.parse(`${to}T00:00:00Z`) + DAY + 14 * 3_600_000) } }).sort({ date: 1, seq: 1 }).lean();
    const inRange = rows.map(this.toInt).filter(e => { const d = localDay(e.date, tz); return d >= from && d <= to; });
    const entries = q?.mode === 'detail' ? inRange : summarizeByDay(inRange, tz);
    const xmlText = tallyXml({ company: str(q?.company, 120) || null, accounts: await this.accounts(storeId), entries, exponent: isoExponent(s.baseCurrency), tz });
    return { xml: xmlText, fileName: `solvexo-tally-${from}-to-${to}.xml` };
  }

  // ── Connections ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private view(c: any) {
    const { secretEnc: _secret, ...rest } = c;
    return rest;
  }

  async listConnections(storeId: string) {
    await this.accounting.requireEnabled(storeId);
    const rows = await this.connections.find({ storeId }).lean();
    const counts = await this.logs.aggregate([{ $match: { storeId } }, { $group: { _id: { app: '$app', status: '$status' }, n: { $sum: 1 } } }]);
    return INTEGRATION_APPS.map(app => {
      const c = rows.find(r => r.app === app);
      const by = (status: string) => counts.find((x: any) => x._id.app === app && x._id.status === status)?.n ?? 0;
      return { app, connected: !!c, connection: c ? this.view(c) : null, log: { sent: by('sent'), failed: by('failed') } };
    });
  }

  /** Saves the connection (keeps the stored secret when none is sent), then tests it; the result is shown on the card. */
  async saveConnection(storeId: string, app: string, body: any, actor: Actor) {
    const s = await this.accounting.requireEnabled(storeId);
    if (!(INTEGRATION_APPS as readonly string[]).includes(app)) throw new BadRequestException('Unknown app.');
    const baseUrl = cleanBaseUrl(body?.baseUrl);
    if (!baseUrl) throw new BadRequestException('Enter the https address of your Odoo or ERPNext, for example https://mycompany.odoo.com.');
    try { await this.checkHost(new URL(baseUrl).hostname); } catch { throw new BadRequestException('That address is not reachable from the internet.'); }
    const existing = await this.connections.findOne({ storeId, app });
    const fields: any = { baseUrl, mode: body?.mode === 'summary' ? 'summary' : 'detail', enabled: body?.enabled !== false };
    if (app === 'odoo') {
      fields.database = str(body?.database, 120); fields.login = str(body?.login, 200); fields.journalCode = str(body?.journalCode, 20) || 'MISC';
      if (!fields.database || !fields.login) throw new BadRequestException('Odoo needs the database name and the login (e-mail).');
    } else {
      fields.company = str(body?.company, 200);
      if (!fields.company) throw new BadRequestException('ERPNext needs the company name.');
    }
    let secret = str(body?.secret, 500);
    if (app === 'erpnext' && (body?.apiKey || body?.apiSecret)) secret = `${str(body?.apiKey, 200)}:${str(body?.apiSecret, 200)}`;
    if (secret) { fields.secretEnc = encryptCredential(secret, 'INTEGRATIONS'); fields.secretHint = maskSecret(secret); }
    else if (!existing) throw new BadRequestException(app === 'odoo' ? 'Enter the Odoo API key.' : 'Enter the ERPNext API key and secret.');
    if (!existing) {
      // Detail mode starts after what is already in the books unless the seller asks for everything since go-live.
      fields.cursorSeq = body?.from === 'go_live' ? 0 : s.entrySeq;
      fields.cursorDay = body?.from === 'go_live' ? null : localDay(new Date(Date.now() - DAY), resolveStoreTimeZone(await this.store(storeId)));
      fields.createdBy = actor.id;
    }
    await this.connections.updateOne({ storeId, app }, { $set: fields, $setOnInsert: { storeId, app } }, { upsert: true });
    return this.test(storeId, app);
  }

  async removeConnection(storeId: string, app: string) {
    await this.connections.deleteOne({ storeId, app });
    return { removed: true };
  }

  private async conn(storeId: string, app: string) {
    const c = await this.connections.findOne({ storeId, app }).lean();
    if (!c) throw new NotFoundException('Not connected.');
    return c;
  }

  /** Signs in and checks the journal (Odoo) or company (ERPNext) exists. */
  async test(storeId: string, app: string) {
    const c = await this.conn(storeId, app);
    let lastCheck: { at: Date; ok: boolean; message: string };
    try {
      const client = await this.client(c);
      lastCheck = { at: new Date(), ok: true, message: await client.check() };
    } catch (e: any) {
      lastCheck = { at: new Date(), ok: false, message: (e instanceof AppError ? e.message : `Could not reach ${app === 'odoo' ? 'Odoo' : 'ERPNext'}: ${e?.message ?? 'error'}`).slice(0, 300) };
    }
    await this.connections.updateOne({ _id: c._id }, { $set: { lastCheck } });
    return this.view({ ...c, lastCheck });
  }

  // ── Clients ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  private async call(url: string, init: any) {
    await this.checkHost(new URL(url).hostname);
    const res = await this.fetchFn(url, init);
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new AppError('The API key was refused. Check it in the connection settings.');
      const msg = body?.exception ?? body?._server_messages ?? body?.message ?? text.slice(0, 200);
      throw new AppError(`The app answered ${res.status}: ${String(msg).slice(0, 250)}`);
    }
    return body;
  }

  private async client(c: any) {
    const secret = decryptCredential(c.secretEnc, 'INTEGRATIONS');
    if (c.app === 'odoo') return this.odoo(c, secret);
    return this.erpnext(c, secret);
  }

  private async odoo(c: any, apiKey: string) {
    let id = 0;
    const rpc = async (service: string, method: string, args: any[]) => {
      const body = await this.call(`${c.baseUrl}/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: ++id }) });
      if (body?.error) throw new AppError(`Odoo: ${body.error.data?.message ?? body.error.message ?? 'error'}`.slice(0, 300));
      return body?.result;
    };
    const uid = await rpc('common', 'authenticate', [c.database, c.login, apiKey, {}]);
    if (!uid) throw new AppError('Odoo refused the login or API key.');
    const kw = (model: string, method: string, args: any[], kwargs: any = {}) => rpc('object', 'execute_kw', [c.database, uid, apiKey, model, method, args, kwargs]);
    const journals = await kw('account.journal', 'search_read', [[['code', '=', c.journalCode]]], { fields: ['id', 'name'], limit: 1 });
    if (!journals?.length) throw new AppError(`Odoo has no journal with the code ${c.journalCode}.`);
    const journalId = journals[0].id;
    const accountIds = new Map<string, number>();
    return {
      check: async () => `Signed in to Odoo; entries go to the journal "${journals[0].name}".`,
      push: async (e: IntEntry, accounts: IntAccount[], exp: number, tz: string): Promise<string> => {
        const missing = unmappedAccounts([e], accounts);
        if (missing.length) throw new AppError(`Give these accounts their Odoo account code: ${missing.map(a => `${a.code} ${a.name}`).join(', ')}.`);
        const codes = [...new Set(e.lines.map(l => accounts.find(a => a.key === l.accountKey)!.externalCode!.trim()))].filter(code => !accountIds.has(code));
        if (codes.length) for (const r of await kw('account.account', 'search_read', [[['code', 'in', codes]]], { fields: ['id', 'code'] })) accountIds.set(String(r.code), r.id);
        const idOf = (key: string) => { const code = accounts.find(a => a.key === key)!.externalCode!.trim(); const i = accountIds.get(code); if (!i) throw new AppError(`Odoo has no account with the code ${code}.`); return i; };
        const found = await kw('account.move', 'search_read', [[['ref', '=', externalRef(e)], ['journal_id', '=', journalId], ['state', '!=', 'cancel']]], { fields: ['id'], limit: 1 });
        if (found?.length) return String(found[0].id); // already there (an earlier attempt timed out after Odoo saved it)
        const moveId = await kw('account.move', 'create', [odooMove(e, idOf, journalId, exp, tz)]);
        await kw('account.move', 'action_post', [[moveId]]);
        return String(moveId);
      },
    };
  }

  private async erpnext(c: any, keySecret: string) {
    const headers = { Authorization: `token ${keySecret}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    const who = await this.call(`${c.baseUrl}/api/method/frappe.auth.get_logged_user`, { method: 'GET', headers });
    const company = await this.call(`${c.baseUrl}/api/resource/Company/${encodeURIComponent(c.company)}`, { method: 'GET', headers }).catch((e: any) => { throw e instanceof AppError && /404/.test(e.message) ? new AppError(`ERPNext has no company named "${c.company}".`) : e; });
    return {
      check: async () => `Signed in to ERPNext as ${who?.message ?? 'the API user'}; entries go to ${company?.data?.name ?? c.company}.`,
      push: async (e: IntEntry, accounts: IntAccount[], exp: number, tz: string): Promise<string> => {
        const missing = unmappedAccounts([e], accounts);
        if (missing.length) throw new AppError(`Give these accounts their ERPNext account name (e.g. "Cash - ABC"): ${missing.map(a => `${a.code} ${a.name}`).join(', ')}.`);
        const filters = encodeURIComponent(JSON.stringify([['cheque_no', '=', externalRef(e)], ['docstatus', '!=', 2], ['company', '=', c.company]]));
        const found = await this.call(`${c.baseUrl}/api/resource/Journal%20Entry?filters=${filters}&fields=${encodeURIComponent('["name"]')}&limit_page_length=1`, { method: 'GET', headers });
        if (found?.data?.length) return String(found.data[0].name);
        const nameOf = (key: string) => accounts.find(a => a.key === key)!.externalCode!.trim();
        const created = await this.call(`${c.baseUrl}/api/resource/Journal%20Entry`, { method: 'POST', headers, body: JSON.stringify(erpnextJournal(e, nameOf, c.company, exp, tz)) });
        return String(created?.data?.name ?? '');
      },
    };
  }

  // ── Sync ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  @Cron('*/30 * * * *')
  async scheduledSync() {
    await this.redis.withLock('accounting:integrations', 29 * 60_000, async () => {
      const rows = await this.connections.find({ enabled: true }).select('storeId app').lean();
      for (const r of rows) {
        try { await this.sync(r.storeId, r.app); } catch (e: any) { this.logger.warn(`Accounting integration ${r.app} for ${r.storeId}: ${e?.message}`); }
      }
    });
  }

  /** Sends what is new, and retries what failed (up to 5 times). Stops at the first connection-level failure (wrong key, app down). */
  async sync(storeId: string, app: string) {
    const c = await this.conn(storeId, app);
    const s = await this.accounting.requireEnabled(storeId);
    const tz = resolveStoreTimeZone(await this.store(storeId));
    const exp = isoExponent(s.baseCurrency);
    const accounts = await this.accounts(storeId);
    let client: Awaited<ReturnType<AccountingIntegrationsService['client']>>;
    try { client = await this.client(c); } catch (e: any) {
      const lastCheck = { at: new Date(), ok: false, message: (e instanceof AppError ? e.message : `Could not reach the app: ${e?.message ?? 'error'}`).slice(0, 300) };
      await this.connections.updateOne({ _id: c._id }, { $set: { lastCheck } });
      return { sent: 0, failed: 0, stopped: lastCheck.message };
    }
    let sent = 0, failed = 0;
    const send = async (itemKey: string, e: IntEntry) => {
      const amount = e.lines.reduce((t, l) => t + l.debitMinor, 0);
      try {
        const externalId = await client.push(e, accounts, exp, tz);
        await this.logs.updateOne({ storeId, app, itemKey }, { $set: { status: 'sent', externalId, error: null, label: e.memo.slice(0, 200), amountMinor: amount, lastTriedAt: new Date() }, $inc: { attempts: 1 } }, { upsert: true });
        sent++;
      } catch (err: any) {
        const error = (err instanceof AppError ? err.message : `Could not send: ${err?.message ?? 'error'}`).slice(0, 500);
        await this.logs.updateOne({ storeId, app, itemKey }, { $set: { status: 'failed', error, label: e.memo.slice(0, 200), amountMinor: amount, lastTriedAt: new Date() }, $inc: { attempts: 1 } }, { upsert: true });
        failed++;
      }
    };

    // 1. Retries
    const retry = await this.logs.find({ storeId, app, status: 'failed', attempts: { $lt: MAX_ATTEMPTS } }).limit(PER_RUN).lean();
    for (const r of retry) {
      const e = await this.itemEntry(storeId, r.itemKey, tz);
      if (e) await send(r.itemKey, e);
      else await this.logs.updateOne({ _id: r._id }, { $set: { status: 'skipped', error: 'Nothing to send for this item any more.' } });
    }

    // 2. New items
    if (c.mode === 'summary') {
      // A day is sent once it is two days old, so late POS sales (offline tills) are in it.
      const last = localDay(new Date(Date.now() - 2 * DAY), tz);
      let day = c.cursorDay ? nextDay(c.cursorDay) : localDay(s.goLiveDate, tz);
      for (let n = 0; n < 31 && day <= last; n++, day = nextDay(day)) {
        const e = await this.itemEntry(storeId, `day:${day}`, tz);
        if (e) await send(`day:${day}`, e);
        await this.connections.updateOne({ _id: c._id }, { $set: { cursorDay: day } });
      }
    } else {
      const rows = await this.journal.find({ storeId, seq: { $gt: c.cursorSeq ?? 0 } }).sort({ seq: 1 }).limit(PER_RUN).lean();
      for (const r of rows) {
        await send(`entry:${r.seq}`, this.toInt(r));
        await this.connections.updateOne({ _id: c._id }, { $set: { cursorSeq: r.seq } });
      }
    }
    await this.connections.updateOne({ _id: c._id }, { $set: { lastSyncAt: new Date(), lastCheck: { at: new Date(), ok: true, message: `Last run: ${sent} sent, ${failed} failed.` } } });
    return { sent, failed };
  }

  private async itemEntry(storeId: string, itemKey: string, tz: string): Promise<IntEntry | null> {
    if (itemKey.startsWith('entry:')) {
      const e = await this.journal.findOne({ storeId, seq: Number(itemKey.slice(6)) }).lean();
      return e ? this.toInt(e) : null;
    }
    const day = itemKey.slice(4);
    const rows = await this.journal.find({ storeId, date: { $gte: new Date(Date.parse(`${day}T00:00:00Z`) - 14 * 3_600_000), $lt: new Date(Date.parse(`${day}T00:00:00Z`) + DAY + 14 * 3_600_000) } }).lean();
    const [e] = summarizeByDay(rows.map(this.toInt).filter(x => localDay(x.date, tz) === day), tz);
    return e ?? null;
  }

  async log(storeId: string, app: string, q: any) {
    await this.accounting.requireEnabled(storeId);
    const filter: any = { storeId, app };
    if (['sent', 'failed', 'skipped'].includes(q?.status)) filter.status = q.status;
    const limit = Math.min(Math.max(Number(q?.limit) || 50, 1), 200);
    const page = Math.max(Number(q?.page) || 1, 1);
    const [items, total] = await Promise.all([this.logs.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.logs.countDocuments(filter)]);
    return { items, total, page, limit };
  }

  /** A failed item gets five more tries, starting now. */
  async retry(storeId: string, app: string, itemKey: string) {
    const r = await this.logs.findOne({ storeId, app, itemKey });
    if (!r) throw new NotFoundException('Not in the log.');
    if (r.status === 'sent') return r.toObject();
    await this.logs.updateOne({ _id: r._id }, { $set: { status: 'failed', attempts: 0 } });
    await this.sync(storeId, app);
    return this.logs.findById(r._id).lean();
  }
}

function nextDay(day: string) { return new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10); }
