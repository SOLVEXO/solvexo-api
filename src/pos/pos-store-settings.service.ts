/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';

type Req = any;
interface Tokens { employee?: string }
const bad = (code: string, message: string, extra: object = {}) => new BadRequestException({ statusCode: 400, code, message, ...extra });

/** Receipt designer (what the printed / shared receipt shows) — defaults keep today's receipts unchanged. */
export const RECEIPT_DEFAULTS = { showLogo: true, showStoreAddress: true, showTaxId: true, showTaxBreakdown: true, showQr: true, showCashierName: true, showCustomerName: true, showLoyaltyBalance: true, showBarcode: false, defaultPaperWidth: 80, promoText: null as string | null };
/** Which in-app alerts managers see (Home pulse / Needs attention). Delivery is in-app only for now. */
export const ALERT_DEFAULTS = { lowStock: true, expiringLots: true, largeRefund: true, cashVariance: true, attendanceAnomalies: true, unsyncedSales: true, sealFailure: true };
/** Till security (the PIN and its lock-out rules stay as built; these are the knobs the owner turns). */
export const SECURITY_DEFAULTS = { autoLockMinutes: 5, lockOnBackground: false, requirePinForReprint: false, hideCostsFromManagers: false };
/** G5.3–G5.5 — provider-dependent features (pending-decision pattern): every one OFF by default; the admin panel / owner turns them on. */
export const CONNECTOR_DEFAULTS = { emailReceipts: false, smsReceipts: false, cardExternalTerminal: false, cardGateway: false, fiscal: false };
/** G5.3: the printed receipt QR's lifetime is at least 30 days. */
export const RECEIPT_LINK_MIN_DAYS = 30;
export function receiptLinkDays(s: { receiptLinkDays?: number | null; returnApprovalAfterDays?: number | null } | null | undefined): number {
  return s?.receiptLinkDays ?? Math.max(RECEIPT_LINK_MIN_DAYS, s?.returnApprovalAfterDays ?? 0);
}

/**
 * G4.4 — store-level settings the settings hub edits (owner only; managers read): receipt designer, in-app alerts, security, plus the sync / backup status read-out.
 * Stored in PosSettings (additive fields, defaults = today's behaviour); every change audited with before / after.
 */
@Injectable()
export class PosStoreSettingsService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer) {}
  private get r(): any { return this.db.repositories; }

  private async read(storeId: string) {
    await this.r.posSettingsModel.updateOne({ storeId }, { $setOnInsert: { storeId } }, { upsert: true });
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('receiptOptions alertPrefs securityPrefs connectorPrefs receiptLinkDays receiptLinkDaysSince returnApprovalAfterDays autoLockMinutes receiptHeader receiptFooter businessName businessAddress businessTaxId').lean();
    return {
      receipt: { ...RECEIPT_DEFAULTS, ...(s?.receiptOptions ?? {}), header: s?.receiptHeader ?? null, footer: s?.receiptFooter ?? null },
      alerts: { ...ALERT_DEFAULTS, ...(s?.alertPrefs ?? {}) },
      security: { ...SECURITY_DEFAULTS, ...(s?.securityPrefs ?? {}), autoLockMinutes: s?.autoLockMinutes ?? SECURITY_DEFAULTS.autoLockMinutes },
      profile: { businessName: s?.businessName ?? null, businessAddress: s?.businessAddress ?? null, businessTaxId: s?.businessTaxId ?? null },
      connectors: { ...CONNECTOR_DEFAULTS, ...(s?.connectorPrefs ?? {}) },
      receiptLinks: { days: receiptLinkDays(s), custom: s?.receiptLinkDays ?? null, minDays: RECEIPT_LINK_MIN_DAYS, since: s?.receiptLinkDaysSince ?? null },
    };
  }

  async get(req: Req, storeId: string, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action: 'settings.approvalLimits.view', employeeToken: t.employee }); // managers + owner read
    return { success: true, data: { ...(await this.read(storeId)), timeZone: await this.pos.storeTz(storeId), canEdit: a.role === 'owner' } };
  }

  /** Owner only. Unknown keys and wrong types are refused (nothing is half-saved). */
  async update(req: Req, storeId: string, body: any, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action: 'settings.store.edit', employeeToken: t.employee });
    const before = await this.read(storeId);
    const set: any = {};
    const bools = (src: any, defs: Record<string, any>, field: string, path: string) => {
      if (src === undefined) return;
      if (!src || typeof src !== 'object' || Array.isArray(src)) throw bad('INVALID_SETTINGS', `${field} must be an object`);
      for (const [k, v] of Object.entries(src)) {
        if (!(k in defs)) throw bad('INVALID_SETTINGS', `${field}.${k} is not a setting`);
        if (typeof defs[k] === 'boolean' && typeof v !== 'boolean') throw bad('INVALID_SETTINGS', `${field}.${k} must be true or false`);
        set[`${path}.${k}`] = v;
      }
    };
    const rc = body?.receipt;
    if (rc !== undefined) {
      const { header, footer, defaultPaperWidth, promoText, ...flags } = rc ?? {};
      bools(flags, RECEIPT_DEFAULTS, 'receipt', 'receiptOptions');
      if (defaultPaperWidth !== undefined) { if (defaultPaperWidth !== 58 && defaultPaperWidth !== 80) throw bad('INVALID_SETTINGS', 'receipt.defaultPaperWidth must be 58 or 80'); set['receiptOptions.defaultPaperWidth'] = defaultPaperWidth; }
      if (promoText !== undefined) { if (promoText !== null && (typeof promoText !== 'string' || promoText.length > 200)) throw bad('INVALID_SETTINGS', 'receipt.promoText is at most 200 characters'); set['receiptOptions.promoText'] = promoText?.trim() || null; }
      for (const [k, v] of [['receiptHeader', header], ['receiptFooter', footer]] as const) if (v !== undefined) { if (v !== null && (typeof v !== 'string' || v.length > 300)) throw bad('INVALID_SETTINGS', `${k} is at most 300 characters`); set[k] = v?.trim() || null; }
    }
    bools(body?.alerts, ALERT_DEFAULTS, 'alerts', 'alertPrefs');
    const sec = body?.security;
    if (sec !== undefined) {
      const { autoLockMinutes, ...flags } = sec ?? {};
      bools(flags, SECURITY_DEFAULTS, 'security', 'securityPrefs');
      if (autoLockMinutes !== undefined) { if (!Number.isInteger(autoLockMinutes) || autoLockMinutes < 1 || autoLockMinutes > 240) throw bad('INVALID_SETTINGS', 'security.autoLockMinutes must be 1–240'); set.autoLockMinutes = autoLockMinutes; }
    }
    bools(body?.connectors, CONNECTOR_DEFAULTS, 'connectors', 'connectorPrefs');
    const rl = body?.receiptLinks;
    if (rl !== undefined) {
      const days = rl?.days;
      if (days !== null && !(Number.isInteger(days) && days >= RECEIPT_LINK_MIN_DAYS && days <= 3650)) throw bad('INVALID_SETTINGS', `receiptLinks.days must be ${RECEIPT_LINK_MIN_DAYS}–3650 days, or null (= the return window, at least ${RECEIPT_LINK_MIN_DAYS})`);
      set.receiptLinkDays = days; set.receiptLinkDaysSince = new Date(); // links of sales made before this change keep their 30 days
    }
    if (!Object.keys(set).length) throw bad('NOTHING_TO_CHANGE', 'Nothing to change');
    await this.r.posSettingsModel.updateOne({ storeId }, { $set: set });
    const after = await this.read(storeId);
    await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId, action: 'store_settings_changed', targetId: storeId, targetType: 'settings', metadata: { changed: Object.keys(set), before: Object.fromEntries(Object.keys(set).map((k) => [k, pick(before, k)])), after: Object.fromEntries(Object.keys(set).map((k) => [k, pick(after, k)])) } }]);
    return this.get(req, storeId, t);
  }

  /** Backup & sync read-out for the settings hub: the server's time, devices and when each was last seen, the latest audit seal. The device adds its own queues. */
  async syncStatus(req: Req, storeId: string, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    await this.auth.authorize(req, { storeId, action: 'settings.approvalLimits.view', employeeToken: t.employee });
    const devices: any[] = this.r.posDeviceModel ? await this.r.posDeviceModel.find({ storeId, revokedAt: null }).select('name lastSeenAt createdAt platform appVersion').sort({ lastSeenAt: -1 }).limit(50).lean() : [];
    const seal: any = this.r.posAuditSealModel ? await this.r.posAuditSealModel.findOne({ storeId }).sort({ day: -1 }).select('day sealedAt count').lean() : null;
    return { success: true, data: { serverTime: new Date(), timeZone: await this.pos.storeTz(storeId), devices: devices.map((d) => ({ id: String(d._id), name: d.name ?? null, platform: d.platform ?? null, appVersion: d.appVersion ?? null, lastSeenAt: d.lastSeenAt ?? null })), lastSeal: seal ? { day: seal.day, sealedAt: seal.sealedAt, records: seal.count } : null } };
  }
}
const pick = (o: any, path: string) => {
  const map: Record<string, string> = { receiptOptions: 'receipt', alertPrefs: 'alerts', securityPrefs: 'security', connectorPrefs: 'connectors', receiptLinkDays: 'receiptLinks.custom', receiptLinkDaysSince: 'receiptLinks.since', receiptHeader: 'receipt.header', receiptFooter: 'receipt.footer', autoLockMinutes: 'security.autoLockMinutes' };
  const [head, ...rest] = path.split('.');
  const p = (map[head] ?? head).split('.').concat(rest);
  return p.reduce((x, k) => (x == null ? x : x[k]), o);
};
