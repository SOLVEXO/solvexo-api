/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { lookup } from 'dns/promises';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { SmsGatewayConfig, SmsGatewayConfigDocument } from './messaging.schema';
import { contactKey } from './messaging-rules.util';
import { getPath, HttpSmsConfig, isPrivateIp, PK_GATEWAY_PRESETS, renderTemplate, validateHttpSmsConfig, withStopFooter } from './sms.util';

export interface SmsSendResult { success: boolean; messageId?: string | null; error?: string }

/** A provider turns (config, secret, phone, text) into one HTTP call. Only the generic HTTP gateway exists; Pakistani gateways are presets of it. */
export interface SmsProvider {
  key: string;
  send(cfg: HttpSmsConfig, ctx: { secret: string; sender: string }, to: string, text: string): Promise<SmsSendResult>;
}

const TIMEOUT_MS = 10_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Generic HTTP SMS gateway: the seller describes their provider's API once (URL, headers, body with {{to}} {{text}} {{sender}} {{secret}}). */
export class HttpSmsProvider implements SmsProvider {
  key = 'generic_http';
  private readonly log = new Logger('HttpSmsProvider');

  /** Refuses a host that resolves to an internal address (checked right before the call; redirects are never followed). */
  private async assertPublicHost(hostname: string) {
    const addrs = await lookup(hostname, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new Error('The gateway host is not a public address');
  }

  async send(cfg: HttpSmsConfig, ctx: { secret: string; sender: string }, to: string, text: string): Promise<SmsSendResult> {
    const vars = { to, text, sender: ctx.sender, secret: ctx.secret };
    try {
      const url = new URL(renderTemplate(cfg.url, vars, 'url'));
      if (url.protocol !== 'https:') return { success: false, error: 'The gateway URL must be https' };
      await this.assertPublicHost(url.hostname);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = renderTemplate(v, vars, 'raw');
      let body: string | undefined;
      if (cfg.method === 'POST') {
        headers['Content-Type'] = cfg.contentType === 'json' ? 'application/json' : 'application/x-www-form-urlencoded';
        body = renderTemplate(cfg.body, vars, cfg.contentType === 'json' ? 'json' : 'form');
      }
      const res = await fetch(url.toString(), { method: cfg.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const raw = (await res.text()).slice(0, 4000);
      if (res.status >= 300 && res.status < 400) return { success: false, error: `HTTP ${res.status} redirect (not followed)` };
      if (!res.ok) return { success: false, error: `HTTP ${res.status} ${raw.slice(0, 150)}`.trim() };
      if (cfg.successMatch && !raw.includes(cfg.successMatch)) return { success: false, error: `The gateway did not confirm: ${raw.slice(0, 150)}` };
      let id: string | null = null;
      try { id = getPath(JSON.parse(raw), cfg.messageIdPath); } catch { /* not JSON: no id */ }
      return { success: true, messageId: id };
    } catch (e: any) {
      this.log.warn(`SMS send failed: ${e?.message}`);
      return { success: false, error: String(e?.message ?? 'Send failed').slice(0, 200) };
    }
  }
}

/** Per-store SMS gateway settings, secret storage (encrypted), verification by a real test message, webhook secret. Off until tested. */
@Injectable()
export class SmsGatewayService {
  private readonly provider: SmsProvider = new HttpSmsProvider();
  constructor(
    @InjectModel(SmsGatewayConfig.name) private readonly model: Model<SmsGatewayConfigDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
  ) {}

  /** Replaceable in tests. */
  setProvider(p: SmsProvider) { (this as any).provider = p; }

  presets() { return PK_GATEWAY_PRESETS; }

  async get(storeId: string) {
    const c: any = await this.model.findOne({ storeId }).select('+secretEnc').lean();
    if (!c) return { configured: false, enabled: false, verified: false, presets: PK_GATEWAY_PRESETS };
    const { secretEnc, webhookSecretHash, ...rest } = c;
    return { configured: true, ...rest, hasSecret: !!secretEnc, hasWebhookSecret: !!webhookSecretHash, verified: !!c.verifiedAt, presets: PK_GATEWAY_PRESETS };
  }

  /** Saves the gateway description. Changing anything the sends depend on switches the gateway off until it is tested again. */
  async save(storeId: string, actor: { id: string; role: string }, body: any) {
    const http: HttpSmsConfig = {
      url: String(body?.http?.url ?? '').trim(), method: body?.http?.method, contentType: body?.http?.contentType ?? 'json',
      headers: body?.http?.headers ?? {}, body: String(body?.http?.body ?? ''), successMatch: body?.http?.successMatch ? String(body.http.successMatch) : null, messageIdPath: body?.http?.messageIdPath ? String(body.http.messageIdPath) : null,
    };
    const err = validateHttpSmsConfig(http);
    if (err) throw new BadRequestException(err);
    const senderId = String(body?.senderId ?? '').trim();
    if (!/^[A-Za-z0-9 ]{1,20}$/.test(senderId)) throw new BadRequestException('Sender name: up to 20 letters, numbers or spaces');
    const presetKey = body?.presetKey && PK_GATEWAY_PRESETS.some((p) => p.key === body.presetKey) ? body.presetKey : null;
    const dailyLimit = body?.dailyLimit == null ? 1000 : body.dailyLimit;
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100_000) throw new BadRequestException('Daily limit must be a whole number between 1 and 100000');
    const set: any = { http, senderId, presetKey, dailyLimit, enabled: false, verifiedAt: null, lastError: null };
    if (body?.secret !== undefined) {
      if (typeof body.secret !== 'string' || body.secret.length > 300) throw new BadRequestException('The secret is too long');
      set.secretEnc = body.secret ? encryptCredential(body.secret, 'INTEGRATIONS') : null;
    }
    await this.model.updateOne({ storeId }, { $set: set, $setOnInsert: { storeId } }, { upsert: true });
    await this.activity.log({ storeId, category: 'marketing', action: 'sms_gateway_saved', description: 'SMS gateway settings saved (gateway switched off until tested)', actorId: actor.id, actorRole: actor.role, targetId: storeId, targetType: 'store' } as any).catch(() => undefined);
    return this.get(storeId);
  }

  private async loaded(storeId: string) {
    const c: any = await this.model.findOne({ storeId }).select('+secretEnc').lean();
    if (!c?.http) throw new BadRequestException('Set up your SMS gateway first.');
    let secret = '';
    if (c.secretEnc) { try { secret = decryptCredential(c.secretEnc, 'INTEGRATIONS'); } catch { throw new BadRequestException('Your SMS gateway secret needs to be entered again.'); } }
    return { c, secret };
  }

  /** Sends one real message to a number the seller types: success verifies the gateway (and the seller may then switch it on). */
  async test(storeId: string, actor: { id: string; role: string }, phone: unknown) {
    const key = contactKey(phone);
    if (!key) throw new BadRequestException('Enter your own phone number');
    const { c, secret } = await this.loaded(storeId);
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('name').lean();
    const res = await this.provider.send(c.http, { secret, sender: c.senderId }, key, `Test message from ${store?.name ?? 'your store'}`);
    await this.model.updateOne({ storeId }, { $set: res.success ? { verifiedAt: new Date(), lastError: null } : { verifiedAt: null, enabled: false, lastError: String(res.error ?? 'Failed').slice(0, 300) } });
    await this.activity.log({ storeId, category: 'marketing', action: res.success ? 'sms_gateway_verified' : 'sms_gateway_test_failed', description: res.success ? 'SMS gateway test succeeded' : `SMS gateway test failed: ${res.error}`, actorId: actor.id, actorRole: actor.role, targetId: storeId, targetType: 'store' } as any).catch(() => undefined);
    if (!res.success) throw new BadRequestException(`The gateway did not accept the test message: ${res.error}`);
    return { success: true };
  }

  /** Switch on / off. Only a gateway whose last settings passed a real test can be switched on. */
  async setEnabled(storeId: string, enabled: boolean) {
    const c: any = await this.model.findOne({ storeId }).lean();
    if (!c) throw new BadRequestException('Set up your SMS gateway first.');
    if (enabled && !c.verifiedAt) throw new BadRequestException('Send a successful test message before switching the gateway on.');
    await this.model.updateOne({ storeId }, { $set: { enabled: !!enabled } });
    return this.get(storeId);
  }

  /** Active gateway for campaigns, or null. */
  async activeConfig(storeId: string): Promise<{ dailyLimit: number } | null> {
    const c: any = await this.model.findOne({ storeId, enabled: true, verifiedAt: { $ne: null } }).select('dailyLimit').lean();
    return c ? { dailyLimit: c.dailyLimit ?? 1000 } : null;
  }

  /** One marketing SMS (the opt-out line is always appended). */
  async sendMarketing(storeId: string, to: string, text: string): Promise<SmsSendResult> {
    const { c, secret } = await this.loaded(storeId);
    if (!c.enabled) return { success: false, error: 'The SMS gateway is switched off' };
    return this.provider.send(c.http, { secret, sender: c.senderId }, to, withStopFooter(text));
  }

  /** G5.3 (additive): one TRANSACTIONAL SMS (a receipt link the customer asked for) — no marketing opt-out footer. Off unless the store's gateway is enabled. */
  async sendTransactional(storeId: string, to: string, text: string): Promise<SmsSendResult> {
    const c0: any = await this.model.findOne({ storeId }).select('enabled verifiedAt').lean();
    if (!c0?.enabled || !c0?.verifiedAt) return { success: false, error: 'The SMS gateway is not set up or switched off' };
    const { c, secret } = await this.loaded(storeId);
    return this.provider.send(c.http, { secret, sender: c.senderId }, to, text);
  }

  /** New webhook secret for delivery reports / replies (shown once, only its hash is kept). */
  async rotateWebhookSecret(storeId: string) {
    if (!(await this.model.exists({ storeId }))) throw new BadRequestException('Set up your SMS gateway first.');
    const secret = randomBytes(24).toString('hex');
    await this.model.updateOne({ storeId }, { $set: { webhookSecretHash: sha(secret) } });
    return { secret, inboundPath: `/api/public/sms/${storeId}/${secret}/inbound`, deliveryPath: `/api/public/sms/${storeId}/${secret}/delivery` };
  }

  async verifyWebhookSecret(storeId: string, secret: string): Promise<boolean> {
    if (typeof secret !== 'string' || secret.length < 20 || secret.length > 100) return false;
    const c: any = await this.model.findOne({ storeId }).select('+webhookSecretHash').lean();
    if (!c?.webhookSecretHash) return false;
    const a = Buffer.from(sha(secret)); const b = Buffer.from(c.webhookSecretHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
