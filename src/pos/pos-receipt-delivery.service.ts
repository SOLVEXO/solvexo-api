/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { EmailService } from '@/otp/services/email.service';
import { SmsGatewayService } from '@/messaging-channels/sms-gateway.service';
import { isoExponent } from '@/common/money-minor.util';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosReceiptService } from './pos-receipt.service';
import { offlineLinkBaseOf } from './pos-receipt-link.util';
import { CONNECTOR_DEFAULTS } from './pos-store-settings.service';
import { RECEIPT_CHANNELS, ReceiptChannel } from './schemas/pos-receipt-delivery.schema';

type Req = any;
interface Tokens { employee?: string }
const err = (status: 400 | 403 | 404 | 409 | 429, code: string, message: string, extra: object = {}) => {
  const body = { statusCode: status, code, message, ...extra };
  if (status === 404) return new NotFoundException(body);
  if (status === 409) return new ConflictException(body);
  if (status === 403) return new ForbiddenException(body);
  if (status === 429) return new HttpException(body, 429);
  return new BadRequestException(body);
};

/** A channel that delivers one short receipt message. The real ones reuse the platform mailer and the store's own SMS gateway (from main). */
export interface ReceiptSender { send(storeId: string, to: string, msg: { subject: string; text: string; html: string; storeName: string }): Promise<{ ok: boolean; error?: string }> }

export const EMAIL_RX = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE_RX = /^\+?[0-9]{10,15}$/;
export const PER_SALE_PER_HOUR = 3;
export const PER_STORE_PER_DAY = 500;
export const maskTo = (channel: ReceiptChannel, to: string) => channel === 'email' ? to.replace(/^(.)[^@]*(@.*)$/, '$1***$2') : `${'*'.repeat(Math.max(0, to.length - 4))}${to.slice(-4)}`;
const norm = (channel: ReceiptChannel, v: string) => channel === 'email' ? v.trim().toLowerCase() : v.replace(/[\s()-]/g, '');

/**
 * G5.3 — send a receipt out of the app by e-mail or SMS. ONLY the public receipt link, the store's name and the total go into the message — never the
 * items or anything personal. Consent: to the contact on the customer's record, or one the customer gave for THIS sale (the cashier confirms). Each
 * channel is a pending-decision connector, OFF by default per store (`connectors.emailReceipts` / `connectors.smsReceipts`); SMS also needs the store's
 * SMS gateway (main's messaging module) set up and switched on. Rate-limited (per sale, per store), append-only log, audited in the same transaction.
 */
@Injectable()
export class PosReceiptDeliveryService {
  private senders: Record<ReceiptChannel, ReceiptSender>;
  constructor(
    private readonly db: DatabaseService,
    private readonly pos: PosService,
    private readonly auth: PosAuthorizer,
    private readonly receipts: PosReceiptService,
    @Optional() email?: EmailService,
    @Optional() sms?: SmsGatewayService,
  ) {
    this.senders = {
      email: { send: async (storeId, to, m) => ({ ok: email ? await email.sendMail(to, m.subject, m.html, null, undefined, undefined, m.storeName, storeId) : false, error: email ? undefined : 'Mail is not configured' }) },
      sms: { send: async (storeId, to, m) => { if (!sms) return { ok: false, error: 'SMS is not configured' }; const r = await sms.sendTransactional(storeId, to, m.text); return { ok: r.success, error: r.error }; } },
    };
  }
  private get r(): any { return this.db.repositories; }
  /** Tests replace the channels. */
  setSender(channel: ReceiptChannel, s: ReceiptSender) { this.senders[channel] = s; }

  /** What the till may offer for this store: which channels are on. */
  async channels(req: Req, storeId: string, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    await this.auth.authorize(req, { storeId, action: 'sales.reprint', employeeToken: t.employee });
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('connectorPrefs').lean();
    const c = { ...CONNECTOR_DEFAULTS, ...(s?.connectorPrefs ?? {}) };
    return { success: true, data: { email: !!c.emailReceipts, sms: !!c.smsReceipts } };
  }

  async send(req: Req, storeId: string, saleId: string, body: any, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action: 'sales.reprint', employeeToken: t.employee });
    const channel = body?.channel as ReceiptChannel;
    if (!(RECEIPT_CHANNELS as readonly string[]).includes(channel)) throw err(400, 'CHANNEL_INVALID', 'channel must be email or sms');
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('connectorPrefs').lean();
    const flags = { ...CONNECTOR_DEFAULTS, ...(s?.connectorPrefs ?? {}) };
    if (!(channel === 'email' ? flags.emailReceipts : flags.smsReceipts)) throw err(409, 'CHANNEL_OFF', channel === 'email' ? 'E-mail receipts are switched off for this store' : 'SMS receipts are switched off for this store');
    if (!Types.ObjectId.isValid(saleId)) throw err(404, 'SALE_NOT_FOUND', 'Sale not found');
    const sale: any = await this.r.saleModel.findOne({ _id: saleId, storeId }).select('storeId status saleNumber totalMinor total currency currencyExponent customerId idempotencyKey receipt').lean();
    if (!sale || sale.status === 'held' || sale.status === 'discarded') throw err(404, 'SALE_NOT_FOUND', 'Sale not found');

    // consent: the customer's own contact on file, or one given for this sale (the cashier confirms)
    let onFile: string | null = null;
    if (sale.customerId && this.r.posCustomerModel && Types.ObjectId.isValid(String(sale.customerId))) {
      const c: any = await this.r.posCustomerModel.findOne({ _id: sale.customerId, storeId }).select('email phone').lean();
      onFile = channel === 'email' ? (c?.email ?? null) : (c?.phone ?? null);
    }
    const given = typeof body?.to === 'string' && body.to.trim() ? norm(channel, body.to) : null;
    const to = given ?? (onFile ? norm(channel, onFile) : null);
    if (!to) throw err(400, 'RECIPIENT_REQUIRED', channel === 'email' ? 'Enter the customer\'s e-mail address' : 'Enter the customer\'s phone number');
    if (channel === 'email' ? !EMAIL_RX.test(to) : !PHONE_RX.test(to)) throw err(400, 'RECIPIENT_INVALID', channel === 'email' ? 'That e-mail address does not look right' : 'That phone number does not look right');
    const consent: 'on_file' | 'given_for_sale' = onFile && norm(channel, onFile) === to ? 'on_file' : 'given_for_sale';
    if (consent === 'given_for_sale' && body?.consent !== 'given_for_sale') throw err(400, 'CONSENT_REQUIRED', 'Confirm the customer gave this contact for their receipt');

    // rate limits
    const hourAgo = new Date(Date.now() - 3_600_000); const dayAgo = new Date(Date.now() - 86_400_000);
    const [perSale, perStore] = await Promise.all([
      this.r.posReceiptDeliveryModel.countDocuments({ storeId, saleId, channel, createdAt: { $gte: hourAgo } }),
      this.r.posReceiptDeliveryModel.countDocuments({ storeId, createdAt: { $gte: dayAgo } }),
    ]);
    if (perSale >= PER_SALE_PER_HOUR) throw err(429, 'RATE_LIMITED', `This receipt was already sent ${PER_SALE_PER_HOUR} times in the last hour`);
    if (perStore >= PER_STORE_PER_DAY) throw err(429, 'RATE_LIMITED', 'The store\'s daily limit for sending receipts is reached');

    // the message: store name, total, the public link — nothing else
    const [store, ps]: any[] = await Promise.all([this.r.storeModel.findById(storeId).select('name slug baseCurrency').lean(), this.r.posSettingsModel.findOne({ storeId }).select('businessName').lean()]);
    const name = ps?.businessName || store?.name || 'Your shop';
    const base = offlineLinkBaseOf(store?.slug).receiptLinkBase;
    const link = base && sale.idempotencyKey && /^pos-\d{13,17}-[0-9a-f]{24}$/.test(sale.idempotencyKey) ? `${base}${sale.idempotencyKey}` : (await this.receipts.getLink(req.user.userId, saleId)).data.url;
    const cur = String(sale.currency || store?.baseCurrency || 'USD').toUpperCase(); const exp = sale.currencyExponent ?? isoExponent(cur);
    const totalMinor = sale.totalMinor ?? Math.round((sale.total ?? 0) * 10 ** exp);
    const total = `${cur} ${(totalMinor / 10 ** exp).toLocaleString('en-US', { minimumFractionDigits: exp, maximumFractionDigits: exp })}`;
    const text = `${name}: your receipt (${total}) — ${link}`;
    const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const html = `<p>Thank you for shopping at ${esc(name)}.</p><p>Your receipt (${esc(total)}): <a href="${esc(link)}">${esc(link)}</a></p>`;
    const res = await this.senders[channel].send(storeId, to, { subject: `Your receipt from ${name}`, text, html, storeName: name });

    const deviceId = req?.user?.posDevice?.deviceId ?? null;
    await this.r.posReceiptDeliveryModel.db.transaction(async (tx: any) => {
      await this.r.posReceiptDeliveryModel.create([{ storeId, saleId, channel, toMasked: maskTo(channel, to), toHash: createHash('sha256').update(`${storeId}:${to}`).digest('hex'), consent, status: res.ok ? 'sent' : 'failed', error: res.ok ? null : String(res.error ?? 'failed').slice(0, 300), employeeId: a.employeeId, deviceId }], { session: tx });
      await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId, action: res.ok ? 'receipt_sent' : 'receipt_send_failed', targetId: saleId, targetType: 'sale', metadata: { channel, to: maskTo(channel, to), consent, saleNumber: sale.saleNumber, error: res.ok ? null : res.error ?? null } }], { session: tx });
    });
    if (!res.ok) throw err(409, 'SEND_FAILED', channel === 'sms' ? 'The SMS could not be sent — check the store\'s SMS gateway' : 'The e-mail could not be sent');
    return { success: true, data: { channel, to: maskTo(channel, to), consent, sentAt: new Date() } };
  }
}
