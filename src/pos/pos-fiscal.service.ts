/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '@/database/databaseservice';
import { toMinor } from '@/common/money-minor.util';
import { JobLeaseService, BUSY } from '@/common/job-lease/job-lease.service';
import { FiscalDisplayLine, FiscalDocumentInput, FiscalProvider, fiscalProviderFor, FiscalResult } from './connectors/fiscal';

export const FISCAL_MAX_ATTEMPTS = 20;
export type FiscalBlock = {
  status: 'not_enabled' | 'pending' | 'confirmed' | 'rejected' | 'failed'; fiscalInvoiceNumber: string | null; qrPayload: string | null; attempts: number; lastError: string | null; testMode?: boolean;
  displayLines?: FiscalDisplayLine[]; logoUrl?: string | null;
};
/** G6.1 — the version of the fiscal block the till reads (docs/pos-blueprint/FISCAL_CONTRACT.md). */
export const FISCAL_CONTRACT_VERSION = 1;
/** One document's provider call is serialised across instances and with the sale-time path (the provider must never be called twice at once). */
const DOC_LEASE_MS = 2 * 60_000;
const SWEEP_LEASE_MS = 10 * 60_000;

/**
 * G5.5 — fiscalisation (behind `connectors.fiscal`, OFF by default). After a sale with a tax invoice, a refund or a void (which makes a credit note), the
 * document is sent to the fiscal provider; each attempt is an append-only `posfiscalrecords` row + an audit row, in one transaction. A provider outage
 * leaves it `pending`; the sweep retries (and also picks up offline sales when they sync, and anything a crash left behind). Our numbers never change.
 */
@Injectable()
export class PosFiscalService {
  private readonly log = new Logger('PosFiscal');
  private provider: FiscalProvider | null;
  constructor(private readonly db: DatabaseService, @Optional() provider?: FiscalProvider, @Optional() private readonly leases?: JobLeaseService) { this.provider = provider ?? fiscalProviderFor(); }
  private get r(): any { return this.db.repositories; }
  setProvider(p: FiscalProvider | null) { this.provider = p; }

  async enabled(storeId: string): Promise<boolean> {
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('connectorPrefs').lean();
    return s?.connectorPrefs?.fiscal === true;
  }

  /** The fiscal block of each document (latest attempt), keyed `invoice:<saleId>` / `credit_note:<id>`. */
  async blocks(docs: Array<{ type: 'invoice' | 'credit_note'; id: string }>): Promise<Map<string, FiscalBlock>> {
    const out = new Map<string, FiscalBlock>();
    if (!docs.length || !this.r.posFiscalRecordModel) return out;
    const rows: any[] = await this.r.posFiscalRecordModel.aggregate([
      { $match: { $or: docs.map((d) => ({ documentType: d.type, documentId: d.id })) } },
      { $sort: { attempt: -1 } },
      { $group: { _id: { t: '$documentType', d: '$documentId' }, last: { $first: '$$ROOT' }, attempts: { $sum: 1 } } },
    ]);
    for (const r of rows) out.set(`${r._id.t}:${r._id.d}`, { status: r.last.status, fiscalInvoiceNumber: r.last.fiscalInvoiceNumber ?? null, qrPayload: r.last.qrPayload ?? null, attempts: r.attempts, lastError: r.last.error ?? null, testMode: !!r.last.testMode, displayLines: r.last.displayLines ?? [], logoUrl: r.last.logoUrl ?? null });
    return out;
  }

  /**
   * The `fiscal` block of a document as responses carry it — the G6.1 contract (FISCAL_CONTRACT.md), a superset of the G5.5 shape:
   * `status` not_enabled (= the contract's not_required; the live value, kept) | pending | confirmed | failed | rejected; `externalInvoiceNumber`, `qrPayload`, `displayLines` [{label, value}] (printed as
   * given), `message` (failed / rejected, for the cashier and owner), `willRetry`, `logoUrl`, `testMode`, `contractVersion`; legacy `attempts`,
   * `lastError` kept. With the store switch on and no attempt yet it reads `pending`. Pending past the attempt limit reads `failed`.
   */
  static view(stored: any, block: FiscalBlock | undefined, storeOn: boolean) {
    const base = { externalInvoiceNumber: null as string | null, qrPayload: null as string | null, displayLines: [] as FiscalDisplayLine[], message: null as string | null, willRetry: false, logoUrl: null as string | null, testMode: false, attempts: 0, lastError: null as string | null, contractVersion: FISCAL_CONTRACT_VERSION };
    if (block) {
      const stopped = block.status === 'pending' && block.attempts >= FISCAL_MAX_ATTEMPTS;
      const status = stopped ? 'failed' : block.status;
      const message = status === 'failed' || status === 'rejected' ? block.lastError ?? (stopped ? 'Automatic retries stopped. Check the document, then retry.' : null) : null;
      return { ...base, status, externalInvoiceNumber: block.fiscalInvoiceNumber, qrPayload: block.qrPayload, displayLines: block.displayLines ?? [], message, willRetry: status === 'pending', logoUrl: block.logoUrl ?? null, testMode: !!block.testMode, attempts: block.attempts, lastError: block.lastError };
    }
    if (storeOn) return { ...base, status: 'pending', willRetry: true };
    // not fiscalised and the store does not fiscalise: the stored placeholder exactly as before (status `not_enabled` = the contract's
    // `not_required`, kept for compatibility with live responses) plus the contract's additive fields
    if (stored && typeof stored === 'object') return { ...base, ...stored, status: stored.status ?? 'not_enabled' };
    return { ...base, status: 'not_enabled' };
  }

  /** A sale read: its invoice's `fiscal` field shows the latest fiscal attempt (unchanged when the store does not fiscalise and nothing was sent). */
  async overlaySale(sale: any): Promise<void> {
    try {
      if (!sale?.invoice || !sale?._id) return;
      const b = (await this.blocks([{ type: 'invoice', id: String(sale._id) }])).get(`invoice:${sale._id}`);
      const on = b ? true : await this.enabled(String(sale.storeId));
      if (b || on) sale.invoice = { ...sale.invoice, fiscal: PosFiscalService.view(sale.invoice.fiscal, b, on) };
    } catch (e: any) { this.log.warn(`fiscal overlay: ${e?.message ?? e}`); }
  }

  /** After a sale / refund / void response: fiscalise what it produced. Never throws (the sale stands; a failure stays pending for the sweep). */
  async afterSaleResponse(storeId: string | undefined, res: any): Promise<void> {
    try {
      const d = res?.data;
      const saleId = d?._id ? String(d._id) : d?.id ? String(d.id) : d?.saleId ? String(d.saleId) : null;
      if (!storeId || !saleId || !(await this.enabled(storeId))) return;
      const b = await this.fiscaliseSale(storeId, saleId);
      // the response's invoice shows the outcome in its existing `fiscal` field (same shape) so the till prints the number / "Fiscal pending" at once
      if (d?.invoice) d.invoice.fiscal = PosFiscalService.view(d.invoice.fiscal, b ?? undefined, true);
      if (d?.creditNote?.id) await this.fiscaliseCreditNote(storeId, String(d.creditNote.id));
    } catch (e: any) { this.log.warn(`fiscalise after response: ${e?.message ?? e}`); }
  }

  async fiscaliseSale(storeId: string, saleId: string, opts: { force?: boolean; requestedBy?: string | null } = {}): Promise<FiscalBlock | null> {
    const sale: any = await this.r.saleModel.findOne({ _id: saleId, storeId }).lean();
    if (!sale?.invoice?.number) return null;
    const exp = sale.currencyExponent ?? 2;
    return this.attempt(storeId, 'invoice', saleId, saleId, {
      storeId, documentType: 'invoice', documentNumber: sale.invoice.number, againstInvoiceNumber: null, issuedAt: new Date(sale.invoice.issuedAt), currency: sale.currency, currencyExponent: exp,
      netMinor: (sale.items ?? []).reduce((n: number, i: any) => n + (i.netMinor ?? 0), 0), taxMinor: sale.taxMinor ?? toMinor(sale.tax ?? 0, exp), totalMinor: sale.totalMinor ?? toMinor(sale.total ?? 0, exp),
      seller: sale.invoice.seller ? { ntn: sale.invoice.seller.ntn ?? null, strn: sale.invoice.seller.strn ?? null, legalName: sale.invoice.seller.legalName ?? null } : null,
      lines: (sale.items ?? []).map((i: any) => ({ name: i.name, qty: i.qty, hsCode: i.hsCode ?? null, netMinor: i.netMinor ?? 0, taxMinor: i.taxMinor ?? 0 })),
    }, opts);
  }

  async fiscaliseCreditNote(storeId: string, creditNoteId: string, opts: { force?: boolean; requestedBy?: string | null } = {}): Promise<FiscalBlock | null> {
    const cn: any = await this.r.posCreditNoteModel.findOne({ _id: creditNoteId, storeId }).lean();
    if (!cn) return null;
    return this.attempt(storeId, 'credit_note', String(cn._id), String(cn.saleId), {
      storeId, documentType: 'credit_note', documentNumber: cn.number, againstInvoiceNumber: cn.invoiceNumber ?? null, issuedAt: new Date(cn.createdAt), currency: cn.currency, currencyExponent: cn.currencyExponent,
      netMinor: cn.netMinor ?? 0, taxMinor: cn.taxMinor ?? 0, totalMinor: cn.totalMinor ?? 0,
      seller: cn.seller ? { ntn: cn.seller.ntn ?? null, strn: cn.seller.strn ?? null, legalName: cn.seller.legalName ?? null } : null,
      lines: (cn.lines ?? []).map((l: any) => ({ name: l.name, qty: l.qty, hsCode: l.hsCode ?? null, netMinor: l.netMinor ?? 0, taxMinor: l.taxMinor ?? 0 })),
    }, opts);
  }

  private async attempt(storeId: string, type: 'invoice' | 'credit_note', documentId: string, saleId: string, input: FiscalDocumentInput, opts: { force?: boolean; requestedBy?: string | null } = {}): Promise<FiscalBlock | null> {
    const run = () => this.attemptLocked(storeId, type, documentId, saleId, input, opts);
    if (!this.leases) return run();
    // G6.1: one provider call per document at a time, across instances and between the sale-time path and the sweep
    const r = await this.leases.withLease(`pos:fiscal:${type}:${documentId}`, DOC_LEASE_MS, run);
    return r === BUSY ? (await this.blocks([{ type, id: documentId }])).get(`${type}:${documentId}`) ?? null : r;
  }

  private async attemptLocked(storeId: string, type: 'invoice' | 'credit_note', documentId: string, saleId: string, input: FiscalDocumentInput, opts: { force?: boolean; requestedBy?: string | null }): Promise<FiscalBlock | null> {
    const prev = (await this.blocks([{ type, id: documentId }])).get(`${type}:${documentId}`); // read INSIDE the lease: a finished attempt is seen
    if (prev && (prev.status === 'confirmed' || prev.status === 'rejected')) return prev;
    if (!opts.force && prev && (prev.status === 'failed' || prev.attempts >= FISCAL_MAX_ATTEMPTS)) return prev;
    const p = this.provider;
    let res: FiscalResult;
    if (!p) res = { status: 'pending', fiscalInvoiceNumber: null, qrPayload: null, message: 'No fiscal provider is configured' };
    else { try { res = await p.fiscalise(input); } catch (e: any) { res = { status: 'pending', fiscalInvoiceNumber: null, qrPayload: null, message: String(e?.message ?? e).slice(0, 300) }; } }
    const lines = (res.displayLines ?? []).filter((l) => l && typeof l.label === 'string' && typeof l.value === 'string').slice(0, 12).map((l) => ({ label: l.label.slice(0, 80), value: l.value.slice(0, 200) }));
    const attempt = (prev?.attempts ?? 0) + 1;
    try {
      await this.r.posFiscalRecordModel.db.transaction(async (tx: any) => {
        await this.r.posFiscalRecordModel.create([{ storeId, documentType: type, documentId, saleId, documentNumber: input.documentNumber, attempt, status: res.status, fiscalInvoiceNumber: res.fiscalInvoiceNumber, qrPayload: res.qrPayload, error: res.status === 'confirmed' ? null : res.message ?? null, providerKey: p?.key ?? 'none', testMode: p?.testMode ?? false, displayLines: lines, logoUrl: res.logoUrl ?? null, requestedBy: opts.requestedBy ?? null }], { session: tx });
        await this.r.posAuditLogModel.create([{ storeId, employeeId: opts.requestedBy ?? null, action: `fiscal_${res.status}`, targetId: documentId, targetType: type === 'invoice' ? 'sale' : 'credit_note', metadata: { documentNumber: input.documentNumber, attempt, fiscalInvoiceNumber: res.fiscalInvoiceNumber, provider: p?.key ?? null, testMode: p?.testMode ?? false, error: res.status === 'confirmed' ? null : res.message ?? null, manualRetry: !!opts.force } }], { session: tx });
      });
    } catch (e: any) { if (e?.code !== 11000) throw e; } // a lease that expired mid-call (stalled holder): the unique index keeps one row per attempt
    return (await this.blocks([{ type, id: documentId }])).get(`${type}:${documentId}`) ?? null;
  }

  /**
   * G6.1 — documents that need the owner: latest attempt failed / rejected, or retries stopped (last `days` days), newest first. Shown on the till
   * (Integrations → Fiscal) and nothing else changes; the sale stands either way.
   */
  async issues(storeId: string, days = 30) {
    if (!this.r.posFiscalRecordModel) return [];
    const since = new Date(Date.now() - days * 86_400_000);
    const rows: any[] = await this.r.posFiscalRecordModel.aggregate([
      { $match: { storeId, createdAt: { $gte: since } } },
      { $sort: { attempt: -1 } },
      { $group: { _id: { t: '$documentType', d: '$documentId' }, last: { $first: '$$ROOT' }, attempts: { $sum: 1 } } },
      { $match: { $or: [{ 'last.status': { $in: ['failed', 'rejected'] } }, { 'last.status': 'pending', attempts: { $gte: FISCAL_MAX_ATTEMPTS } }] } },
      { $sort: { 'last.createdAt': -1 } },
      { $limit: 200 },
    ]);
    return rows.map((r) => {
      const v = PosFiscalService.view(null, { status: r.last.status, fiscalInvoiceNumber: r.last.fiscalInvoiceNumber ?? null, qrPayload: r.last.qrPayload ?? null, attempts: r.attempts, lastError: r.last.error ?? null, testMode: !!r.last.testMode, displayLines: r.last.displayLines ?? [], logoUrl: r.last.logoUrl ?? null }, true);
      return { documentType: r._id.t, documentId: r._id.d, saleId: r.last.saleId, documentNumber: r.last.documentNumber, status: v.status, message: v.message, attempts: r.attempts, lastAttemptAt: r.last.createdAt, retryable: v.status === 'failed' };
    });
  }

  /** G6.1 — the owner sends a `failed` document again (after checking it): one new attempt, audited with who asked. Rejected / confirmed: refused. */
  async retry(storeId: string, documentType: 'invoice' | 'credit_note', documentId: string, requestedBy: string) {
    if (documentType !== 'invoice' && documentType !== 'credit_note') throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'documentType must be invoice or credit_note' });
    const prev = (await this.blocks([{ type: documentType, id: documentId }])).get(`${documentType}:${documentId}`);
    const v = prev ? PosFiscalService.view(null, prev, true) : null;
    if (!v || v.status !== 'failed') throw new BadRequestException({ code: 'FISCAL_NOT_RETRYABLE', message: v?.status === 'rejected' ? 'The tax authority refused this document; it cannot be sent again as it is.' : 'Only a document whose fiscalisation failed can be retried.' });
    const b = documentType === 'invoice' ? await this.fiscaliseSale(storeId, documentId, { force: true, requestedBy }) : await this.fiscaliseCreditNote(storeId, documentId, { force: true, requestedBy });
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Document not found' });
    return PosFiscalService.view(null, b, true);
  }

  /** The sweep: pending documents again, plus fiscal-enabled stores' recent invoices / credit notes that have no record yet (offline sales that synced, a crash). */
  @Cron(process.env.POS_FISCAL_SWEEP_CRON || '*/2 * * * *')
  async sweepTick(): Promise<void> {
    // G6.1: one sweep at a time across instances (each document is also leased inside attempt())
    if (!this.leases) { await this.sweep(); return; }
    await this.leases.withLease('pos:fiscal-sweep', SWEEP_LEASE_MS, () => this.sweep());
  }

  async sweep(limit = 50): Promise<number> {
    if (!this.r.posFiscalRecordModel) return 0;
    const stores: string[] = (await this.r.posSettingsModel.find({ 'connectorPrefs.fiscal': true }).select('storeId').lean()).map((s: any) => s.storeId);
    if (!stores.length) return 0;
    let done = 0;
    const since = new Date(Date.now() - 7 * 86_400_000);
    for (const storeId of stores) {
      const sales: any[] = await this.r.saleModel.find({ storeId, 'invoice.number': { $type: 'string' }, createdAt: { $gte: since } }).select('_id').sort({ createdAt: -1 }).limit(500).lean();
      const cns: any[] = await this.r.posCreditNoteModel.find({ storeId, createdAt: { $gte: since } }).select('_id').sort({ createdAt: -1 }).limit(500).lean();
      const docs = [...sales.map((s) => ({ type: 'invoice' as const, id: String(s._id) })), ...cns.map((c) => ({ type: 'credit_note' as const, id: String(c._id) }))];
      const b = await this.blocks(docs);
      for (const d of docs) {
        if (done >= limit) return done;
        const cur = b.get(`${d.type}:${d.id}`);
        if (cur && cur.status !== 'pending') continue; // confirmed / rejected / failed: not resent automatically
        if (cur && cur.attempts >= FISCAL_MAX_ATTEMPTS) continue;
        if (d.type === 'invoice') await this.fiscaliseSale(storeId, d.id); else await this.fiscaliseCreditNote(storeId, d.id);
        done++;
      }
    }
    return done;
  }
}
