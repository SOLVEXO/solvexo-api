/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PlatformTaxService } from '../platform-tax/platform-tax.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { resolveStoreCountry } from '../integrations/payment-availability.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { B2BCompany, B2BCompanyDocument } from '../b2b/b2b.schema';
import { FbrDiSettings, FbrDiSettingsDocument, FbrInvoiceDocument, FbrInvoiceRecord, StoreFbrSettings, StoreFbrSettingsDocument } from './fbr-di.schemas';
import { FbrDiClient } from './fbr-di.client';
import { assertProductionAllowed, PRODUCTION_LOCKED_MESSAGE } from './fbr-production-lock';
import { buildOrderInput, buildPlanInvoiceInput } from './fbr-di.builders';
import {
  buildPayload, FBR_MAX_ATTEMPTS, FBR_NEEDS_INFO_MAX_DAYS, FBR_NEEDS_INFO_RETRY_MINUTES, FBR_STALE_IN_FLIGHT_MINUTES, FbrInvoiceInput,
  fbrTokenFingerprint, FbrMode, FbrResult, isValidFbrInvoiceNumber, maskToken, normalizeHsCode, normalizeNtnCnic, pktDate,
  platformInvoiceTreatment, qrText, retryDelayMinutes, validateInvoiceInput,
} from './fbr-di.util';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PLATFORM_DEFAULTS = { enabled: false, mode: 'sandbox', province: '', scenarioId: 'SN019', hsCode: '', uom: 'Numbers, pieces, units', saleType: 'Services', enabledSince: null };
const STORE_DEFAULTS = { enabled: false, mode: 'sandbox', province: '', legalName: '', scenarioId: 'SN002', hsCode: '', uom: 'Numbers, pieces, units', saleType: 'Goods at standard rate (default)', enabledSince: null };
const PROVINCE_FALLBACK = ['PUNJAB', 'SINDH', 'KHYBER PAKHTUNKHWA', 'BALOCHISTAN', 'ISLAMABAD CAPITAL TERRITORY', 'AZAD JAMMU AND KASHMIR', 'GILGIT BALTISTAN'];

/** Shown on every "needs a credit/debit note" record. The 72-hour and 180-day rules are the owner's research, still to be confirmed in writing by the accountant. */
const ADJUSTMENT_RULES = 'Per FBR rules (still to be confirmed by your accountant): a filed invoice can be cancelled or edited only within 72 hours, through FBR\'s own system; after that only with the Commissioner\'s approval. A later return or discount needs a credit/debit note within 180 days. Solvexo does not file it for you.';
const UNKNOWN_STALE_MESSAGE = 'The server stopped while this invoice was being sent, so it is not known whether FBR filed it. It is NOT sent again automatically. Check the FBR portal.';

export interface UpdateSettingsInput {
  enabled?: boolean; mode?: FbrMode; province?: string; legalName?: string; scenarioId?: string;
  hsCode?: string; uom?: string; saleType?: string;
}

export interface ResolveInput { action: 'filed' | 'resend'; fbrInvoiceNumber?: string; fbrDated?: string }

@Injectable()
export class FbrDiService {
  private readonly logger = new Logger(FbrDiService.name);
  private provinceCache: { at: number; list: string[] } | null = null;

  constructor(
    @InjectModel(FbrDiSettings.name) private readonly platformModel: Model<FbrDiSettingsDocument>,
    @InjectModel(StoreFbrSettings.name) private readonly storeModel: Model<StoreFbrSettingsDocument>,
    @InjectModel(FbrInvoiceRecord.name) private readonly invoiceModel: Model<FbrInvoiceDocument>,
    private readonly db: DatabaseService,
    private readonly client: FbrDiClient,
    private readonly platformTax: PlatformTaxService,
    private readonly exchangeRate: ExchangeRateService,
    private readonly activityLog: ActivityLogService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() @InjectModel(B2BCompany.name) private readonly b2bCompanyModel?: Model<B2BCompanyDocument>,
  ) {}

  // ───────────────────────── tokens ─────────────────────────
  /**
   * Solvexo's own SANDBOX token lives in a Railway variable, never in the database. A production token is never read:
   * production filing is hard-locked (see fbr-production-lock.ts).
   */
  platformToken(mode: FbrMode): string | null {
    if (mode === 'production') return null;
    const v = process.env.FBR_DI_TOKEN_SANDBOX;
    return v?.trim() || null;
  }

  private async storeToken(storeId: string, mode: FbrMode): Promise<string | null> {
    if (mode === 'production') return null; // production tokens are not used while filing is locked
    const doc: any = await this.storeModel.findOne({ storeId }).select('+tokenSandboxEnc').lean();
    const enc: string | null = doc?.tokenSandboxEnc ?? null;
    if (!enc) return null;
    try { return decryptCredential(enc, 'INTEGRATIONS'); } catch (e) {
      this.logger.error(`FBR token for store ${storeId} could not be decrypted: ${(e as Error).message}`);
      return null;
    }
  }

  // ───────────────────────── Solvexo (platform) settings ─────────────────────────
  async getPlatformSettings() {
    const s: any = { key: 'platform', ...PLATFORM_DEFAULTS, ...this.dropNullish(await this.platformModel.findOne({ key: 'platform' }).lean()) };
    const tax: any = await this.platformTax.getSettings();
    const sandboxToken = this.platformToken('sandbox');
    // A sandbox test only counts while the token is the very one it was run with (the fingerprint is stored, never the token).
    const testFresh = !!s.lastTestOk && !!sandboxToken && s.lastTestTokenFp === fbrTokenFingerprint(sandboxToken);
    const { lastTestTokenFp: _fp, ...rest } = s;
    return {
      ...rest,
      lastTestOk: s.lastTestAt ? testFresh : null,
      lastTestMessage: s.lastTestAt && s.lastTestOk && !testFresh ? 'The sandbox token changed since the last test. Test again.' : s.lastTestMessage ?? null,
      tokenConfigured: { sandbox: !!sandboxToken, production: false },
      productionLocked: !assertProductionAllowed(),
      identity: { legalName: tax.legalName || '', ntn: tax.ntn || '', strn: tax.strn || '', address: tax.address || '', authority: tax.authority || 'FBR' },
      stats: await this.stats({ issuer: 'platform' }),
    };
  }

  async updatePlatformSettings(dto: UpdateSettingsInput, adminId: string) {
    const cur: any = (await this.platformModel.findOne({ key: 'platform' }).lean()) ?? {};
    const set = this.pickSettings(dto);
    const nextEnabled = dto.enabled ?? cur.enabled ?? false;
    const nextMode = (dto.mode ?? cur.mode ?? 'sandbox') as FbrMode;
    // HARD LOCK: setting mode=production, or switching on while the stored mode is production, is refused.
    if (!assertProductionAllowed() && (dto.mode === 'production' || (nextEnabled && nextMode === 'production'))) {
      throw new BadRequestException(PRODUCTION_LOCKED_MESSAGE);
    }
    if (nextEnabled && !this.platformToken('sandbox')) {
      throw new BadRequestException('Add FBR_DI_TOKEN_SANDBOX in the server variables before switching FBR invoicing on.');
    }
    // Reporting starts from the moment invoicing is switched on (or the mode changes), never backwards.
    if (nextEnabled && (!cur.enabled || !cur.enabledSince || (dto.mode && dto.mode !== cur.mode))) set.enabledSince = new Date();
    await this.platformModel.updateOne({ key: 'platform' }, { $set: set, $setOnInsert: { key: 'platform' } }, { upsert: true });
    this.activityLog.log({ category: 'platform_plans', action: 'fbr_di_settings_updated', description: `FBR invoicing settings updated (enabled=${nextEnabled}, mode=${nextMode})`, actorId: adminId, actorRole: 'admin' });
    return this.getPlatformSettings();
  }

  /** A stored document may lack fields (older rows, upserts): fall back to the defaults instead of undefined. */
  private dropNullish(doc: any): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(doc ?? {})) if (v !== undefined && v !== null) out[k] = v;
    return out;
  }

  private pickSettings(dto: UpdateSettingsInput): Record<string, any> {
    const out: Record<string, any> = {};
    for (const k of ['enabled', 'mode', 'province', 'legalName', 'scenarioId', 'hsCode', 'uom', 'saleType'] as const) {
      if (dto[k] !== undefined) out[k] = typeof dto[k] === 'string' ? (dto[k] as string).trim() : dto[k];
    }
    return out;
  }

  /** Sandbox-only dry run (validateinvoicedata): proves the token, URL, identity and field format without filing anything. */
  async testPlatform(adminId: string) {
    const s: any = await this.getPlatformSettings();
    const token = this.platformToken('sandbox');
    if (!token) throw new BadRequestException('FBR_DI_TOKEN_SANDBOX is not set on the server.');
    const input: FbrInvoiceInput = {
      invoiceType: 'Sale Invoice', invoiceDate: pktDate(new Date()),
      sellerNTNCNIC: normalizeNtnCnic(s.identity.ntn), sellerBusinessName: s.identity.legalName, sellerProvince: s.province, sellerAddress: s.identity.address,
      buyerNTNCNIC: null, buyerBusinessName: 'Test Buyer', buyerProvince: s.province, buyerAddress: s.identity.address || 'Karachi',
      buyerRegistrationType: 'Unregistered', scenarioId: s.scenarioId,
      items: [{ hsCode: normalizeHsCode(s.hsCode), productDescription: 'Solvexo plan subscription (test)', rate: '18%', uoM: s.uom, quantity: 1, totalValues: 1180, valueSalesExcludingST: 1000, salesTaxApplicable: 180, saleType: s.saleType }],
    };
    const outcome = await this.runTest(input, token);
    await this.platformModel.updateOne({ key: 'platform' }, { $set: { lastTestAt: new Date(), lastTestOk: outcome.ok, lastTestMessage: outcome.message, lastTestTokenFp: fbrTokenFingerprint(token) }, $setOnInsert: { key: 'platform' } }, { upsert: true });
    this.activityLog.log({ category: 'platform_plans', action: 'fbr_di_test', description: `FBR sandbox test: ${outcome.message}`, actorId: adminId, actorRole: 'admin' });
    return outcome;
  }

  private async runTest(input: FbrInvoiceInput, token: string): Promise<{ ok: boolean; message: string; errors: FbrResult['errors'] }> {
    const problems = validateInvoiceInput(input);
    if (problems.length) return { ok: false, message: problems[0], errors: problems.map((m) => ({ code: null, message: m })) };
    const { result } = await this.client.validate(input, 'sandbox', token);
    return { ok: result.ok, message: result.ok ? 'FBR sandbox accepted the sample invoice.' : result.errors[0]?.message ?? 'FBR did not accept the sample invoice.', errors: result.errors };
  }

  // ───────────────────────── store settings ─────────────────────────
  private async loadStoreOrThrow(storeId: string): Promise<any> {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('name country baseCurrency taxId taxRegistered businessAddress sellerId').lean();
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  private storeBlockers(store: any): string[] {
    const b: string[] = [];
    if (resolveStoreCountry(store) !== 'PK') b.push('FBR digital invoicing is only for Pakistani stores.');
    if (!store.taxId || normalizeNtnCnic(store.taxId).length < 7) b.push('Add your NTN in Settings → Taxes → Tax registration.');
    if (store.taxRegistered === false) b.push('Your store is marked "not registered for sales tax".');
    if (!store.businessAddress?.trim()) b.push('Add your business address in Settings → Taxes → Tax registration.');
    return b;
  }

  async getStoreSettings(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const store = await this.loadStoreOrThrow(storeId);
    const s: any = { ...STORE_DEFAULTS, ...this.dropNullish(await this.storeModel.findOne({ storeId }).lean()) };
    const needsInfo = await this.invoiceModel.countDocuments({ issuer: 'platform', storeId, status: 'needs_info' });
    return {
      enabled: !!s.enabled, mode: s.mode ?? 'sandbox', province: s.province ?? '', legalName: s.legalName ?? '',
      scenarioId: s.scenarioId ?? 'SN002', hsCode: s.hsCode ?? '', uom: s.uom ?? 'Numbers, pieces, units',
      saleType: s.saleType ?? 'Goods at standard rate (default)', enabledSince: s.enabledSince ?? null,
      tokenSandbox: s.tokenSandboxHint ? { set: true, hint: s.tokenSandboxHint } : { set: false, hint: null },
      tokenProduction: s.tokenProductionHint ? { set: true, hint: s.tokenProductionHint } : { set: false, hint: null },
      productionLocked: !assertProductionAllowed(),
      lastTestAt: s.lastTestAt ?? null, lastTestOk: s.lastTestOk ?? null, lastTestMessage: s.lastTestMessage ?? null,
      identity: { taxId: store.taxId ?? '', taxRegistered: store.taxRegistered !== false, address: store.businessAddress ?? '', storeName: store.name },
      blockers: this.storeBlockers(store),
      /** Solvexo could not invoice this store yet because its province / address is missing. */
      solvexoInvoicesNeedInfo: needsInfo,
      stats: await this.stats({ issuer: 'store', storeId }),
    };
  }

  async updateStoreSettings(storeId: string, sellerId: string, dto: UpdateSettingsInput) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const store = await this.loadStoreOrThrow(storeId);
    const cur: any = (await this.storeModel.findOne({ storeId }).lean()) ?? {};
    const set = this.pickSettings(dto);
    const nextEnabled = dto.enabled ?? cur.enabled ?? false;
    const nextMode = (dto.mode ?? cur.mode ?? 'sandbox') as FbrMode;
    // HARD LOCK: setting mode=production, or switching on while the stored mode is production, is refused.
    if (!assertProductionAllowed() && (dto.mode === 'production' || (nextEnabled && nextMode === 'production'))) {
      throw new BadRequestException(PRODUCTION_LOCKED_MESSAGE);
    }
    if (nextEnabled) {
      const blockers = this.storeBlockers(store);
      if (blockers.length) throw new BadRequestException(blockers[0]);
      if (!(await this.storeToken(storeId, 'sandbox'))) throw new BadRequestException('Save your FBR sandbox token first.');
      const prov = (set.province ?? cur.province ?? '').toString().trim();
      if (!prov) throw new BadRequestException('Choose your province.');
    }
    if (nextEnabled && (!cur.enabled || !cur.enabledSince || (dto.mode && dto.mode !== cur.mode))) set.enabledSince = new Date();
    await this.storeModel.updateOne({ storeId }, { $set: set, $setOnInsert: { storeId } }, { upsert: true });
    this.activityLog.log({ storeId, category: 'platform_plans', action: 'fbr_di_store_settings_updated', description: `Store FBR invoicing settings updated (enabled=${nextEnabled}, mode=${nextMode})`, actorRole: 'seller' });
    return this.getStoreSettings(storeId, sellerId);
  }

  async setStoreToken(storeId: string, sellerId: string, mode: FbrMode, token: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    if (mode === 'production') throw new BadRequestException('A production token is not accepted while live filing is locked. Only the sandbox token can be saved.');
    const t = String(token ?? '').trim();
    if (t.length < 20 || /\s/.test(t)) throw new BadRequestException('That does not look like an FBR security token.');
    // A different token invalidates the previous sandbox test: it has to be run again with this one.
    const field = { tokenSandboxEnc: encryptCredential(t, 'INTEGRATIONS'), tokenSandboxHint: maskToken(t), lastTestAt: null, lastTestOk: null, lastTestMessage: null };
    await this.storeModel.updateOne({ storeId }, { $set: field, $setOnInsert: { storeId } }, { upsert: true });
    this.activityLog.log({ storeId, category: 'platform_plans', action: 'fbr_di_token_saved', description: 'FBR sandbox token saved (the previous test result was cleared)', actorRole: 'seller' });
    return this.getStoreSettings(storeId, sellerId);
  }

  async deleteStoreToken(storeId: string, sellerId: string, mode: FbrMode) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const unset = mode === 'production' ? { tokenProductionEnc: null, tokenProductionHint: null } : { tokenSandboxEnc: null, tokenSandboxHint: null };
    const cur: any = await this.storeModel.findOne({ storeId }).lean();
    const set: Record<string, any> = { ...unset, lastTestAt: null, lastTestOk: null, lastTestMessage: null };
    if (cur?.mode === mode) set.enabled = false; // no token for the active mode: stop reporting
    await this.storeModel.updateOne({ storeId }, { $set: set });
    return this.getStoreSettings(storeId, sellerId);
  }

  async testStore(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const store = await this.loadStoreOrThrow(storeId);
    const token = await this.storeToken(storeId, 'sandbox');
    if (!token) throw new BadRequestException('Save your FBR sandbox token first.');
    const s: any = { ...STORE_DEFAULTS, ...this.dropNullish(await this.storeModel.findOne({ storeId }).lean()) };
    const addr = store.businessAddress || '';
    const input: FbrInvoiceInput = {
      invoiceType: 'Sale Invoice', invoiceDate: pktDate(new Date()),
      sellerNTNCNIC: normalizeNtnCnic(store.taxId), sellerBusinessName: s.legalName || store.name, sellerProvince: s.province ?? '', sellerAddress: addr,
      buyerNTNCNIC: null, buyerBusinessName: 'Test Customer', buyerProvince: s.province ?? '', buyerAddress: addr || 'Karachi',
      buyerRegistrationType: 'Unregistered', scenarioId: s.scenarioId ?? 'SN002',
      items: [{ hsCode: normalizeHsCode(s.hsCode), productDescription: 'Test item', rate: '18%', uoM: s.uom ?? 'Numbers, pieces, units', quantity: 1, totalValues: 1180, valueSalesExcludingST: 1000, salesTaxApplicable: 180, saleType: s.saleType ?? 'Goods at standard rate (default)' }],
    };
    const outcome = await this.runTest(input, token);
    await this.storeModel.updateOne({ storeId }, { $set: { lastTestAt: new Date(), lastTestOk: outcome.ok, lastTestMessage: outcome.message } });
    return outcome;
  }

  /** FBR's own province spellings (reference API 5.1) when a token works, otherwise the standard list. */
  async provinces(token: string | null): Promise<string[]> {
    if (this.provinceCache && Date.now() - this.provinceCache.at < DAY) return this.provinceCache.list;
    if (token) {
      const rows = await this.client.reference('provinces', token);
      const list = (rows ?? []).map((r: any) => String(r?.stateProvinceDesc ?? '').trim()).filter(Boolean);
      if (list.length) { this.provinceCache = { at: Date.now(), list }; return list; }
    }
    return PROVINCE_FALLBACK;
  }

  async provincesForStore(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    return this.provinces(await this.storeToken(storeId, 'sandbox'));
  }

  // ───────────────────────── listing ─────────────────────────
  private async stats(filter: Record<string, any>) {
    const rows: any[] = await this.invoiceModel.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const out: Record<string, number> = { pending: 0, submitted: 0, failed: 0, rejected: 0, needs_info: 0, needs_review: 0, skipped: 0, held_rule: 0, unknown_outcome: 0 };
    for (const r of rows) out[r._id] = r.n;
    return out;
  }

  async list(filter: { issuer: 'platform' | 'store'; storeId?: string; status?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Math.floor(filter.page || 1));
    const limit = Math.min(50, Math.max(1, Math.floor(filter.limit || 20)));
    const q: Record<string, any> = { issuer: filter.issuer };
    if (filter.storeId) q.storeId = filter.storeId;
    if (filter.status) q.status = filter.status;
    const [items, total] = await Promise.all([
      this.invoiceModel.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.invoiceModel.countDocuments(q),
    ]);
    return { items, total, page, limit };
  }

  async orderInvoice(storeId: string, orderId: string) {
    const r: any = await this.invoiceModel.findOne({ issuer: 'store', source: 'order', sourceId: String(orderId), storeId, kind: 'sale' }).select('status mode fbrInvoiceNumber fbrDated qrText').lean();
    return r ?? null;
  }

  async planInvoicesForStore(storeId: string) {
    const rows: any[] = await this.invoiceModel.find({ issuer: 'platform', source: 'plan_invoice', storeId, kind: 'sale' }).select('sourceId status mode fbrInvoiceNumber fbrDated qrText').limit(500).lean();
    return rows;
  }

  /** Everything the printable Solvexo invoice shows: Solvexo's legal identity, the invoice, the buyer and the FBR number. */
  async solvexoInvoiceDocument(storeId: string, sellerId: string, invoiceId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, sellerId);
    const inv: any = await this.db.repositories.platformPlanInvoiceModel.findOne({ _id: invoiceId, storeId, isDelete: false }).lean();
    if (!inv) throw new NotFoundException('Invoice not found');
    const [tax, plan, store, rec, sf, seller]: any[] = await Promise.all([
      this.platformTax.getSettings(),
      this.db.repositories.platformPlanModel.findById(inv.platformPlanId).select('name').lean(),
      this.db.repositories.storeModel.findById(storeId).select('name taxId taxRegistered businessAddress').lean(),
      this.invoiceModel.findOne({ issuer: 'platform', source: 'plan_invoice', sourceId: String(inv._id), kind: 'sale' }).select('status mode fbrInvoiceNumber fbrDated qrText netAmount taxAmount fxRatePKRPerUSD').lean(),
      this.storeModel.findOne({ storeId }).select('legalName province').lean(),
      this.db.repositories.sellerModel.findById(sellerId).select('name address').lean(),
    ]);
    const net = inv.subtotalUSD ?? inv.amountUSD - (inv.taxAmountUSD ?? 0);
    return {
      invoice: { id: String(inv._id), number: inv.invoiceNumber, date: inv.paidAt ?? inv.createdAt, status: inv.status, type: inv.type, planName: plan?.name ?? 'Plan', currency: 'USD',
        subtotal: net, tax: inv.taxAmountUSD ?? 0, taxLabel: inv.taxLabel ?? null, taxRatePercent: inv.taxRatePercent ?? 0, total: inv.amountUSD, refunded: inv.refundedAmountUSD ?? 0 },
      seller: { legalName: tax.legalName || '', ntn: tax.ntn || '', strn: tax.strn || '', address: tax.address || '', authority: tax.authority || 'FBR' },
      buyer: { name: sf?.legalName || store?.name || seller?.name || '', taxId: store?.taxRegistered === false ? '' : store?.taxId ?? '', address: store?.businessAddress || seller?.address || '', province: sf?.province ?? '' },
      fbr: rec ? { status: rec.status, mode: rec.mode, invoiceNumber: rec.fbrInvoiceNumber ?? null, dated: rec.fbrDated ?? null, qrText: rec.qrText ?? null, netPKR: rec.fxRatePKRPerUSD ? rec.netAmount : null, taxPKR: rec.fxRatePKRPerUSD ? rec.taxAmount : null, fxRate: rec.fxRatePKRPerUSD ?? null } : null,
    };
  }

  // ───────────────────────── sync: turn paid invoices / orders into FBR records ─────────────────────────
  private async existingKeys(issuer: string, source: string, ids: string[]): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows: any[] = await this.invoiceModel.find({ issuer, source, sourceId: { $in: ids.slice(i, i + 1000) } }).select('sourceId kind status').lean();
      for (const r of rows) {
        const set = map.get(r.sourceId) ?? new Set<string>();
        set.add(`${r.kind}:${r.status}`); set.add(r.kind);
        map.set(r.sourceId, set);
      }
    }
    return map;
  }

  private async createRecord(doc: Partial<FbrInvoiceRecord>): Promise<boolean> {
    try { await this.invoiceModel.create(doc); return true; } catch (e: any) {
      if (e?.code === 11000) return false; // already recorded by a parallel run
      throw e;
    }
  }

  /**
   * Plan invoices paid since reporting was switched on -> FBR records. Only an invoice whose tax was charged under Pakistani
   * rules and is above zero is queued (sandbox only); every other invoice is HELD (held_rule) with the reason, never skipped,
   * never treated as zero, never sent. Returns how many records were created.
   */
  async syncPlatform(): Promise<number> {
    const s: any = { ...PLATFORM_DEFAULTS, ...this.dropNullish(await this.platformModel.findOne({ key: 'platform' }).lean()) };
    if (!s?.enabled || !s.enabledSince) return 0;
    const since = new Date(Math.max(new Date(s.enabledSince).getTime(), Date.now() - 45 * DAY));
    const invs: any[] = await this.db.repositories.platformPlanInvoiceModel
      .find({ status: { $in: ['paid', 'partially_refunded', 'refunded'] }, isDelete: false, paidAt: { $gte: since } })
      .select('storeId sellerId invoiceNumber taxAmountUSD taxRatePercent taxCountry subtotalUSD refundedAmountUSD amountUSD paidAt').sort({ paidAt: 1 }).limit(5000).lean();
    if (!invs.length) return 0;
    const known = await this.existingKeys('platform', 'plan_invoice', invs.map((i) => String(i._id)));
    let created = 0;
    for (const inv of invs) {
      const id = String(inv._id);
      const have = known.get(id);
      if (!have?.has('sale')) {
        const t = platformInvoiceTreatment(inv);
        const ok = await this.createRecord({
          issuer: 'platform', source: 'plan_invoice', sourceId: id, storeId: inv.storeId, sellerId: inv.sellerId, kind: 'sale', mode: s.mode, reference: inv.invoiceNumber,
          status: t.eligible ? 'pending' : 'held_rule', nextAttemptAt: t.eligible ? new Date() : null, note: t.reason,
        });
        if (ok) created++;
      } else if ((inv.refundedAmountUSD ?? 0) > 0 && have.has('sale:submitted') && !have.has('adjustment')) {
        const ok = await this.createRecord({
          issuer: 'platform', source: 'plan_invoice', sourceId: id, storeId: inv.storeId, sellerId: inv.sellerId, kind: 'adjustment', mode: s.mode, reference: inv.invoiceNumber,
          status: 'needs_review', note: `$${Number(inv.refundedAmountUSD).toFixed(2)} of this reported invoice was refunded. ${ADJUSTMENT_RULES}`,
        });
        if (ok) created++;
      }
    }
    return created;
  }

  /** Orders of stores that report to FBR -> pending records (15 minutes after the order, so an immediate cancel is not reported). */
  async syncStores(): Promise<number> {
    const stores: any[] = await this.storeModel.find({ enabled: true, enabledSince: { $ne: null } }).select('storeId mode enabledSince').lean();
    let created = 0;
    for (const st of stores) {
      try { created += await this.syncOneStore(st); } catch (e) { this.logger.error(`FBR order sync failed for store ${st.storeId}: ${(e as Error).message}`); }
    }
    return created;
  }

  private async syncOneStore(st: any): Promise<number> {
    const since = new Date(Math.max(new Date(st.enabledSince).getTime(), Date.now() - 30 * DAY));
    const before = new Date(Date.now() - 15 * MIN);
    const orders: any[] = await this.db.repositories.orderModel
      .find({ 'sellerOrders.storeId': st.storeId, isDelete: { $ne: true }, createdAt: { $gte: since, $lte: before } })
      .select('orderNumber currency createdAt sellerOrders.storeId sellerOrders.status sellerOrders.refundedTotal sellerOrders.sellerId').sort({ createdAt: 1 }).limit(500).lean();
    if (!orders.length) return 0;
    const known = await this.existingKeys('store', 'order', orders.map((o) => String(o._id)));
    let created = 0;
    for (const o of orders) {
      const id = String(o._id);
      const so = (o.sellerOrders ?? []).find((x: any) => x.storeId === st.storeId);
      if (!so) continue;
      const have = known.get(id);
      const gone = ['cancelled', 'refunded'].includes(so.status);
      if (!have?.has('sale')) {
        let status: string = 'pending'; let note: string | null = null;
        if (o.currency !== 'PKR') { status = 'held_rule'; note = `The order was paid in ${o.currency}. How a rupee invoice must be made for it is not verified yet, so it is held, not skipped and not sent.`; }
        else if (gone) { status = 'skipped'; note = 'Cancelled or refunded before it was reported.'; }
        const ok = await this.createRecord({
          issuer: 'store', source: 'order', sourceId: id, storeId: st.storeId, sellerId: so.sellerId ?? '', kind: 'sale', mode: st.mode ?? 'sandbox', reference: o.orderNumber,
          status: status as any, nextAttemptAt: status === 'pending' ? new Date() : null, note,
        });
        if (ok) created++;
      } else if (have.has('sale:submitted') && !have.has('adjustment') && (gone || (so.refundedTotal ?? 0) > 0)) {
        const ok = await this.createRecord({
          issuer: 'store', source: 'order', sourceId: id, storeId: st.storeId, sellerId: so.sellerId ?? '', kind: 'adjustment', mode: st.mode ?? 'sandbox', reference: o.orderNumber,
          status: 'needs_review', note: `This reported order was cancelled or refunded. ${ADJUSTMENT_RULES}`,
        });
        if (ok) created++;
      }
    }
    return created;
  }

  // ───────────────────────── sending ─────────────────────────
  /**
   * A record still marked "in flight" after the lease ran out lost its worker between "sending" and "saving the answer": FBR may
   * or may not have filed it. FBR has no duplicate-check call, so it becomes unknown_outcome and is NEVER resent automatically.
   */
  async sweepStaleInFlight(): Promise<number> {
    const cutoff = new Date(Date.now() - FBR_STALE_IN_FLIGHT_MINUTES * MIN);
    const stale: any[] = await this.invoiceModel.find({ inFlightAt: { $lte: cutoff } }).select('_id inFlightAt').lean();
    let n = 0;
    for (const r of stale) {
      const res = await this.invoiceModel.updateOne({ _id: r._id, inFlightAt: r.inFlightAt }, { $set: { status: 'unknown_outcome', inFlightAt: null, nextAttemptAt: null, authError: false, errors: [{ code: null, message: UNKNOWN_STALE_MESSAGE }] } });
      if (res.modifiedCount > 0) {
        n++;
        const rec = await this.invoiceModel.findById(r._id).lean();
        if (rec) await this.problem(rec, 'FBR invoice outcome unknown', UNKNOWN_STALE_MESSAGE);
      }
    }
    return n;
  }

  async processDue(limit = 50): Promise<{ attempted: number; submitted: number }> {
    await this.sweepStaleInFlight().catch((e) => this.logger.error(`FBR stale in-flight sweep failed: ${e.message}`));
    const now = new Date();
    const main: any[] = await this.invoiceModel.find({ kind: 'sale', status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: now }, attempts: { $lt: FBR_MAX_ATTEMPTS }, inFlightAt: null })
      .select('_id').sort({ nextAttemptAt: 1 }).limit(limit).lean();
    // needs_info is checked again every hour for 14 days; it does not use up attempts.
    const cutoff = new Date(now.getTime() - FBR_NEEDS_INFO_MAX_DAYS * DAY);
    const info: any[] = await this.invoiceModel.find({ kind: 'sale', status: 'needs_info', nextAttemptAt: { $lte: now }, inFlightAt: null })
      .select('_id needsInfoSince').sort({ nextAttemptAt: 1 }).limit(limit).lean();
    const ids = [...main.map((r) => r._id), ...info.filter((r) => !r.needsInfoSince || new Date(r.needsInfoSince) >= cutoff).map((r) => r._id)].slice(0, limit);
    let submitted = 0;
    for (const _id of ids) {
      const r = await this.attempt(String(_id));
      if (r?.status === 'submitted') submitted++;
    }
    return { attempted: ids.length, submitted };
  }

  /**
   * One sending attempt. The record is leased for 10 minutes first, so two workers can never post the same invoice twice, and
   * it is marked IN FLIGHT right before the HTTP call, so a crash between "sent" and "saved" is detected later (sweep) instead of
   * silently resent.
   */
  async attempt(id: string): Promise<FbrInvoiceDocument | null> {
    const now = new Date();
    const lease = { nextAttemptAt: new Date(now.getTime() + 10 * MIN), lastAttemptAt: now };
    let rec: any = await this.invoiceModel.findOneAndUpdate(
      { _id: id, kind: 'sale', status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: now }, inFlightAt: null },
      { $set: lease, $inc: { attempts: 1 } },
      { new: true },
    );
    let consumed = true; // this try counts as an attempt
    if (!rec) {
      rec = await this.invoiceModel.findOneAndUpdate({ _id: id, kind: 'sale', status: 'needs_info', nextAttemptAt: { $lte: now }, inFlightAt: null }, { $set: lease }, { new: true });
      consumed = false;
      if (rec?.needsInfoSince && new Date(rec.needsInfoSince).getTime() < now.getTime() - FBR_NEEDS_INFO_MAX_DAYS * DAY) {
        await this.invoiceModel.updateOne({ _id: id }, { $set: { nextAttemptAt: null } }); // 14 days passed: stop checking, a person can still press "Send again"
        return null;
      }
    }
    if (!rec) return null;
    const restore = consumed ? Math.max(0, rec.attempts - 1) : rec.attempts; // attempts value to keep when this try must not count
    let posting = false;
    try {
      const ctx = await this.buildContext(rec);
      if ('skip' in ctx) return await this.finish(rec, { status: 'skipped', note: ctx.skip, nextAttemptAt: null, attempts: restore });
      if ('hold' in ctx) return await this.finish(rec, { nextAttemptAt: new Date(Date.now() + ctx.hold.minutes * MIN), attempts: restore, note: ctx.hold.note });
      if ('heldRule' in ctx) return await this.finish(rec, { status: 'held_rule', note: ctx.heldRule, errors: [], nextAttemptAt: null, attempts: restore });
      if ('problems' in ctx) {
        return await this.finish(rec, {
          status: 'needs_info', errors: ctx.problems.map((m) => ({ code: null, message: m })),
          nextAttemptAt: new Date(Date.now() + FBR_NEEDS_INFO_RETRY_MINUTES * MIN), needsInfoSince: rec.needsInfoSince ?? now, attempts: restore,
        });
      }

      const flag = await this.invoiceModel.updateOne({ _id: rec._id, inFlightAt: null }, { $set: { inFlightAt: new Date() } });
      if (!flag.modifiedCount) return null; // someone else took it
      posting = true;
      const { result, payload } = await this.client.post(ctx.input, ctx.mode, ctx.token);
      return await this.applyResult(rec, result, payload, ctx, restore);
    } catch (e) {
      this.logger.error(`FBR attempt for ${rec.reference} crashed: ${(e as Error).message}`);
      // Once the call may have left, a crash means the outcome is unknown, not "failed".
      if (posting) return this.markUnknown(rec, {}, [{ code: null, message: 'An unexpected error happened while sending, so it is not known whether FBR filed this invoice. It is NOT sent again automatically. Check the FBR portal.' }]);
      return this.finish(rec, { status: 'failed', errors: [{ code: null, message: 'Unexpected error while preparing the invoice. It will be retried.' }], nextAttemptAt: new Date(Date.now() + retryDelayMinutes(rec.attempts) * MIN) });
    }
  }

  private async markUnknown(rec: any, common: Record<string, any>, errors: FbrResult['errors']) {
    const out = await this.finish(rec, { ...common, status: 'unknown_outcome', authError: false, errors, nextAttemptAt: null, note: 'Not sent again automatically: FBR may already have this invoice. A person must check the FBR portal and resolve it.' });
    await this.problem(rec, 'FBR invoice outcome unknown', errors[0]?.message);
    return out;
  }

  private async applyResult(rec: any, r: FbrResult, payload: Record<string, unknown>, ctx: { net: number; tax: number; fx?: number | null }, restore: number) {
    const common = { payload, netAmount: ctx.net, taxAmount: ctx.tax, ...(ctx.fx ? { fxRatePKRPerUSD: ctx.fx } : {}) };
    if (r.locked) {
      // Production filing is locked: nothing was sent and this try does not count.
      return this.finish(rec, { nextAttemptAt: new Date(Date.now() + 60 * MIN), attempts: restore, note: PRODUCTION_LOCKED_MESSAGE, errors: [] });
    }
    if (r.ok && r.invoiceNumber) {
      this.activityLog.log({ storeId: rec.storeId, category: 'platform_plans', action: 'fbr_invoice_submitted', description: `FBR invoice ${r.invoiceNumber} filed for ${rec.reference} (${rec.mode})`, actorRole: 'system', targetId: String(rec._id), targetType: 'fbr_invoice' });
      return this.finish(rec, { ...common, status: 'submitted', fbrInvoiceNumber: r.invoiceNumber, fbrDated: r.dated, qrText: qrText(r.invoiceNumber), errors: [], authError: false, nextAttemptAt: null });
    }
    if (r.authError) {
      await this.problem(rec, 'FBR rejected the security token', r.errors[0]?.message);
      return this.finish(rec, { ...common, status: 'failed', authError: true, errors: r.errors, nextAttemptAt: null });
    }
    if (r.unknownOutcome) return this.markUnknown(rec, common, r.errors);
    if (r.retryable) {
      // Only reached when the request provably never left (DNS / connection refused): nothing can have been filed.
      const giveUp = rec.attempts >= FBR_MAX_ATTEMPTS;
      if (giveUp) await this.problem(rec, 'FBR invoice could not be sent after many tries', r.errors[0]?.message);
      return this.finish(rec, { ...common, status: 'failed', authError: false, errors: r.errors, nextAttemptAt: giveUp ? null : new Date(Date.now() + retryDelayMinutes(rec.attempts) * MIN) });
    }
    await this.problem(rec, 'FBR rejected an invoice', r.errors[0]?.message);
    return this.finish(rec, { ...common, status: 'rejected', authError: false, errors: r.errors, nextAttemptAt: null });
  }

  /** Saves the outcome and clears the in-flight mark. */
  private async finish(rec: any, set: Record<string, any>): Promise<FbrInvoiceDocument | null> {
    await this.invoiceModel.updateOne({ _id: rec._id }, { $set: { ...set, inFlightAt: null } });
    return this.invoiceModel.findById(rec._id) as any;
  }

  /**
   * Tells the right person, ONCE per record (notifiedAt): Solvexo's own invoice problems go to the admins; a store's go to its
   * owner, in-app and by email (the type is in SELLER_EMAIL_TYPES). Never throws, never includes a token.
   */
  private async problem(rec: any, title: string, message?: string): Promise<void> {
    try {
      const body = `${rec.reference}: ${message ?? 'see the FBR invoice list for details'}`;
      this.activityLog.log({ storeId: rec.storeId, category: 'platform_plans', action: 'fbr_invoice_problem', description: `${title} — ${body}`, actorRole: 'system', targetId: String(rec._id), targetType: 'fbr_invoice' });
      const claim = await this.invoiceModel.updateOne({ _id: rec._id, notifiedAt: null }, { $set: { notifiedAt: new Date() } });
      if (!claim.modifiedCount) return;
      if (rec.issuer === 'platform') {
        await this.notifications?.notifyAdmins({ type: NOTIFICATION_TYPES.ADMIN_PLATFORM_BILLING_FAILED, title, body, data: { storeId: rec.storeId, link: '/admin/settings' } });
      } else if (rec.sellerId) {
        await this.notifications?.notify({
          recipientId: rec.sellerId, recipientRole: 'seller', storeId: rec.storeId, type: NOTIFICATION_TYPES.FBR_INVOICE_PROBLEM,
          title, body, data: { storeId: rec.storeId, recordId: String(rec._id), link: `/store/${rec.storeId}/settings` },
        });
      }
    } catch { /* alerting must never break sending */ }
  }

  /** Rebuilds the invoice from CURRENT data (so fixing a missing field and retrying works). */
  private async buildContext(rec: any): Promise<
    | { skip: string } | { hold: { minutes: number; note: string } } | { heldRule: string } | { problems: string[] }
    | { input: FbrInvoiceInput; mode: FbrMode; token: string; net: number; tax: number; fx?: number | null }
  > {
    if (rec.issuer === 'platform') return this.buildPlatformContext(rec);
    return this.buildStoreContext(rec);
  }

  private async buildPlatformContext(rec: any): Promise<any> {
    const s: any = await this.getPlatformSettings();
    if (!s.enabled) return { hold: { minutes: 60, note: 'FBR invoicing is switched off; will continue when it is switched on.' } };
    // HARD LOCK: nothing is ever sent in production mode.
    if (!assertProductionAllowed() && (rec.mode === 'production' || s.mode === 'production')) return { hold: { minutes: 60, note: PRODUCTION_LOCKED_MESSAGE } };
    if (s.mode !== rec.mode) return { skip: `Reporting mode changed from ${rec.mode} to ${s.mode} after this invoice was queued.` };
    const token = this.platformToken('sandbox');
    if (!token) return { problems: ['FBR_DI_TOKEN_SANDBOX is not set on the server.'] };
    const inv: any = await this.db.repositories.platformPlanInvoiceModel.findById(rec.sourceId).lean();
    if (!inv) return { skip: 'The plan invoice no longer exists.' };
    // Also applied to records queued before this rule existed: no verified treatment => on hold, never sent.
    const treatment = platformInvoiceTreatment(inv);
    if (!treatment.eligible) return { heldRule: treatment.reason };
    const [plan, store, seller, sf]: any[] = await Promise.all([
      this.db.repositories.platformPlanModel.findById(inv.platformPlanId).select('name').lean(),
      this.db.repositories.storeModel.findById(inv.storeId).select('name taxId taxRegistered businessAddress').lean(),
      this.db.repositories.sellerModel.findById(inv.sellerId).select('name address').lean(),
      this.storeModel.findOne({ storeId: inv.storeId }).select('legalName province').lean(),
    ]);
    const fx = rec.fxRatePKRPerUSD ?? (await this.exchangeRate.convert(1, 'USD', 'PKR').catch(() => null));
    if (!fx || !(fx > 0)) return { hold: { minutes: 30, note: 'No USD to PKR exchange rate is available yet.' } };
    const { input, netPKR, taxPKR } = buildPlanInvoiceInput({
      invoice: inv, planName: plan?.name ?? 'Plan', fxPKRPerUSD: fx,
      seller: { ntn: s.identity.ntn, legalName: s.identity.legalName, address: s.identity.address, province: s.province, scenarioId: s.scenarioId, hsCode: s.hsCode, uom: s.uom, saleType: s.saleType },
      buyer: { name: sf?.legalName || store?.name || seller?.name || '', taxId: store?.taxId, taxRegistered: store?.taxRegistered !== false, address: store?.businessAddress || seller?.address || '', province: sf?.province ?? '' },
    });
    const problems = validateInvoiceInput(input);
    if (problems.length) {
      return { problems: problems.map((p) => (p.startsWith('Buyer province') || p.startsWith('Buyer address') ? `${p} The seller can add it in Settings → Taxes → FBR digital invoicing.` : p)) };
    }
    return { input, mode: s.mode as FbrMode, token, net: netPKR, tax: taxPKR, fx };
  }

  private async buildStoreContext(rec: any): Promise<any> {
    const sf: any = { ...STORE_DEFAULTS, ...this.dropNullish(await this.storeModel.findOne({ storeId: rec.storeId }).lean()) };
    if (!sf.enabled) return { hold: { minutes: 60, note: 'FBR invoicing is switched off for this store; will continue when it is switched on.' } };
    // HARD LOCK: nothing is ever sent in production mode.
    if (!assertProductionAllowed() && (rec.mode === 'production' || sf.mode === 'production')) return { hold: { minutes: 60, note: PRODUCTION_LOCKED_MESSAGE } };
    if (sf.mode !== rec.mode) return { skip: `Reporting mode changed from ${rec.mode} to ${sf.mode} after this order was queued.` };
    const token = await this.storeToken(rec.storeId, 'sandbox');
    if (!token) return { problems: ['No FBR sandbox token is saved for this store.'] };
    const store: any = await this.db.repositories.storeModel.findById(rec.storeId).select('name country baseCurrency taxId taxRegistered businessAddress').lean();
    if (!store) return { skip: 'Store no longer exists.' };
    const blockers = this.storeBlockers(store);
    if (blockers.length) return { problems: blockers };
    const order: any = await this.db.repositories.orderModel.findById(rec.sourceId).lean();
    const so = order?.sellerOrders?.find((x: any) => x.storeId === rec.storeId);
    if (!order || !so) return { skip: 'The order no longer exists.' };
    if (['cancelled', 'refunded'].includes(so.status)) return { skip: 'Cancelled or refunded before it was reported.' };
    if (order.currency !== 'PKR') return { heldRule: `The order was paid in ${order.currency}. How a rupee invoice must be made for it is not verified yet.` };
    const variantIds = [...new Set((so.items ?? []).map((i: any) => i.variantId).filter(Boolean))] as string[];
    const variants: any[] = variantIds.length ? await this.db.repositories.productVariantModel.find({ _id: { $in: variantIds } }).select('hsCode').lean() : [];
    const hsByVariant: Record<string, string | null> = {};
    for (const v of variants) hsByVariant[String(v._id)] = v.hsCode ?? null;

    // Wholesale order: the buyer is the company. Its tax ID comes from the company record of THIS store (never another store's).
    let b2b: { companyName?: string | null; taxId?: string | null } | null = null;
    const extraIssues: string[] = [];
    if (order.b2b?.companyId) {
      const company: any = this.b2bCompanyModel ? await this.b2bCompanyModel.findOne({ _id: order.b2b.companyId, storeId: rec.storeId }).select('name taxId').lean() : null;
      if (!company) extraIssues.push('The wholesale company on this order could not be found, so the buyer details are incomplete.');
      b2b = { companyName: order.b2b.companyName || company?.name || null, taxId: company?.taxId ?? null };
    }
    const { input, netTotal, taxTotal, buyerIssues } = buildOrderInput({
      order, items: so.items ?? [], hsByVariant, storeName: store.name, b2b,
      seller: { taxId: store.taxId, taxRegistered: store.taxRegistered !== false, legalName: sf.legalName || store.name, address: store.businessAddress ?? '', province: sf.province ?? '', scenarioId: sf.scenarioId, hsCode: sf.hsCode, uom: sf.uom, saleType: sf.saleType },
    });
    const problems = [...new Set([...extraIssues, ...buyerIssues, ...validateInvoiceInput(input)])];
    if (problems.length) return { problems };
    return { input, mode: sf.mode as FbrMode, token, net: netTotal, tax: taxTotal };
  }

  // ───────────────────────── manual retry / resolve ─────────────────────────
  async retry(id: string, scope: { issuer: 'platform' } | { issuer: 'store'; storeId: string }) {
    const q: Record<string, any> = { _id: id, issuer: scope.issuer, kind: 'sale' };
    if (scope.issuer === 'store') q.storeId = scope.storeId;
    const rec: any = await this.invoiceModel.findOne(q).lean();
    if (!rec) throw new NotFoundException('Invoice not found');
    const blocked: Record<string, string> = {
      submitted: 'This invoice was already filed with FBR.',
      skipped: 'This invoice was skipped and cannot be sent.',
      held_rule: 'This invoice is on hold because its tax treatment is not verified yet. It cannot be sent until a verified rule exists.',
      unknown_outcome: 'FBR may already have this invoice. Check the FBR portal, then use "I checked: it was filed" or "Not filed, send again".',
    };
    if (blocked[rec.status]) throw new BadRequestException(blocked[rec.status]);
    if (rec.inFlightAt) throw new BadRequestException('This invoice is being sent right now. Wait a moment.');
    await this.invoiceModel.updateOne({ _id: id }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), authError: false } });
    const done = await this.attempt(id);
    return done ?? (await this.invoiceModel.findById(id).lean());
  }

  /**
   * A person settles an invoice whose outcome is unknown, after checking the FBR portal. ONCE per record:
   *  - 'filed'  : FBR has it; the person enters the FBR invoice number (format checked) and the record becomes submitted;
   *  - 'resend' : FBR does not have it; it is sent once more.
   * Both are written to the audit log with who did it.
   */
  async resolve(id: string, scope: { issuer: 'platform' } | { issuer: 'store'; storeId: string }, input: ResolveInput, actor: { id: string; role: 'admin' | 'seller' }) {
    const q: Record<string, any> = { _id: id, issuer: scope.issuer, kind: 'sale' };
    if (scope.issuer === 'store') q.storeId = scope.storeId;
    const rec: any = await this.invoiceModel.findOne(q).lean();
    if (!rec) throw new NotFoundException('Invoice not found');
    if (rec.status !== 'unknown_outcome') throw new BadRequestException('Only an invoice whose outcome is unknown can be resolved.');
    if (rec.resolvedAt) throw new BadRequestException('This invoice was already resolved once. It cannot be resolved again.');
    let number = '';
    if (input.action === 'filed') {
      number = String(input.fbrInvoiceNumber ?? '').trim();
      if (!isValidFbrInvoiceNumber(number)) throw new BadRequestException('Enter the FBR invoice number exactly as the FBR portal shows it (7-digit NTN or 13-digit CNIC, then DI, then 13 digits).');
    } else if (input.action !== 'resend') {
      throw new BadRequestException('Unknown action.');
    }
    const claim = await this.invoiceModel.updateOne({ _id: id, status: 'unknown_outcome', resolvedAt: null }, { $set: { resolvedAt: new Date(), resolvedBy: actor.id, resolution: input.action } });
    if (!claim.modifiedCount) throw new BadRequestException('This invoice was already resolved.');
    this.activityLog.log({
      storeId: rec.storeId, category: 'platform_plans', action: input.action === 'filed' ? 'fbr_invoice_resolved_filed' : 'fbr_invoice_resolved_resend',
      description: input.action === 'filed' ? `${rec.reference}: a person confirmed from the FBR portal that it was filed (${number})` : `${rec.reference}: a person confirmed from the FBR portal that it was NOT filed; sent again`,
      actorId: actor.id, actorRole: actor.role, targetId: String(rec._id), targetType: 'fbr_invoice',
    });
    if (input.action === 'filed') {
      await this.invoiceModel.updateOne({ _id: id }, { $set: { status: 'submitted', fbrInvoiceNumber: number, fbrDated: input.fbrDated?.trim() || null, qrText: qrText(number), errors: [], authError: false, nextAttemptAt: null, inFlightAt: null, note: 'Confirmed by a person from the FBR portal (the number was entered by hand, FBR did not return it to Solvexo).' } });
      return this.invoiceModel.findById(id).lean();
    }
    await this.invoiceModel.updateOne({ _id: id }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), authError: false, note: 'Sent again after a person checked the FBR portal and found no such invoice.' } });
    const done = await this.attempt(id);
    return done ?? (await this.invoiceModel.findById(id).lean());
  }

  /** Guard used by the seller routes: a store may only touch its own records. */
  assertStoreScope(rec: { storeId?: string } | null, storeId: string) {
    if (!rec || rec.storeId !== storeId) throw new ForbiddenException('Not your invoice');
  }

  /** Runs one full cycle (called by the scheduler). */
  async runCycle(): Promise<{ created: number; attempted: number; submitted: number }> {
    const created = (await this.syncPlatform().catch((e) => { this.logger.error(`FBR platform sync: ${e.message}`); return 0; }))
      + (await this.syncStores().catch((e) => { this.logger.error(`FBR store sync: ${e.message}`); return 0; }));
    const { attempted, submitted } = await this.processDue();
    return { created, attempted, submitted };
  }
}

// Re-exported so specs can build the same payload the service sends.
export { buildPayload };
