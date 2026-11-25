/* eslint-disable prettier/prettier */
import { BadRequestException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DatabaseService } from '@/database/databaseservice';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { API_KEY_SCOPES, ApiKeyScope } from './schemas/pos-api-key.schema';

type Req = any;
interface Tokens { employee?: string }
const bad = (code: string, message: string) => new BadRequestException({ statusCode: 400, code, message });
export const API_KEY_MAX_PER_STORE = 10;
export const API_KEY_MAX_DAYS = 365;
export const API_KEY_DEFAULT_DAYS = 90;
export const apiKeyRatePerMinute = () => Math.max(1, Number(process.env.API_KEY_RATE_PER_MIN) || 60);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** `sxk_<prefix 12>_<secret 43>` — prefix finds the row, the secret is checked against its hash. */
const KEY_RE = /^sxk_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export interface ApiKeyPrincipal { keyId: string; storeId: string; scopes: ApiKeyScope[]; prefix: string }

/**
 * G5.7 — store API keys: OWNER only (create / list / revoke), READ-ONLY scopes, the secret shown once and stored hashed, an expiry (≤ 365 days),
 * revocable at once, rate-limited per key, and every use written to the audit log. Documented in pos/docs/pos-blueprint/API_KEYS.md.
 */
@Injectable()
export class PosApiKeysService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer) {}
  private get r(): any { return this.db.repositories; }

  private async owner(req: Req, storeId: string, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    return this.auth.authorize(req, { storeId, action: 'settings.store.edit', employeeToken: t.employee }); // owner only
  }
  private view(k: any, now = new Date()) {
    const status = k.revokedAt ? 'revoked' : new Date(k.expiresAt) <= now ? 'expired' : 'active';
    return { id: String(k._id), name: k.name, prefix: k.prefix, scopes: k.scopes, status, createdAt: k.createdAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt ?? null, lastUsedAt: k.lastUsedAt ?? null };
  }

  async list(req: Req, storeId: string, t: Tokens) {
    await this.owner(req, storeId, t);
    const rows: any[] = await this.r.posApiKeyModel.find({ storeId }).sort({ createdAt: -1 }).limit(100).lean();
    return { success: true, data: { keys: rows.map((k) => this.view(k)), scopes: API_KEY_SCOPES, maxActive: API_KEY_MAX_PER_STORE, ratePerMinute: apiKeyRatePerMinute() } };
  }

  async create(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.owner(req, storeId, t);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) throw bad('NAME_REQUIRED', 'Give the key a name (up to 60 characters), e.g. the app it is for');
    const scopes = Array.isArray(body?.scopes) ? [...new Set(body.scopes as string[])] : [];
    if (!scopes.length || scopes.some((s) => !(API_KEY_SCOPES as readonly string[]).includes(s))) throw bad('SCOPES_INVALID', `Choose at least one of: ${API_KEY_SCOPES.join(', ')}`);
    const days = body?.expiresInDays === undefined ? API_KEY_DEFAULT_DAYS : body.expiresInDays;
    if (!Number.isInteger(days) || days < 1 || days > API_KEY_MAX_DAYS) throw bad('EXPIRY_INVALID', `A key expires after 1–${API_KEY_MAX_DAYS} days`);
    const now = new Date();
    const active = await this.r.posApiKeyModel.countDocuments({ storeId, revokedAt: null, expiresAt: { $gt: now } });
    if (active >= API_KEY_MAX_PER_STORE) throw new HttpException({ statusCode: 409, code: 'TOO_MANY_KEYS', message: `A store can have at most ${API_KEY_MAX_PER_STORE} active keys — revoke one first` }, 409);
    const prefix = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
    const secret = randomBytes(32).toString('base64url'); // 43 chars
    const key = `sxk_${prefix}_${secret}`;
    let doc: any;
    await this.r.posApiKeyModel.db.transaction(async (tx: any) => {
      [doc] = await this.r.posApiKeyModel.create([{ storeId, name, prefix, secretHash: sha(secret), scopes, expiresAt: new Date(now.getTime() + days * 86_400_000), createdBy: a.employeeId ?? 'owner' }], { session: tx });
      await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId ?? null, action: 'api_key_created', targetId: String(doc._id), targetType: 'api_key', metadata: { name, prefix, scopes, expiresInDays: days } }], { session: tx });
    });
    // the ONLY time the full key is returned
    return { success: true, data: { key, shownOnce: true, apiKey: this.view(doc.toObject ? doc.toObject() : doc) } };
  }

  async revoke(req: Req, storeId: string, keyId: string, t: Tokens) {
    const a = await this.owner(req, storeId, t);
    const k: any = await this.r.posApiKeyModel.findOne({ _id: keyId, storeId }).lean().catch(() => null);
    if (!k) throw new NotFoundException({ statusCode: 404, code: 'API_KEY_NOT_FOUND', message: 'No such key in this store' });
    if (k.revokedAt) return { success: true, data: { apiKey: this.view(k), alreadyRevoked: true } };
    await this.r.posApiKeyModel.db.transaction(async (tx: any) => {
      await this.r.posApiKeyModel.updateOne({ _id: keyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedBy: a.employeeId ?? 'owner' } }, { session: tx });
      await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId ?? null, action: 'api_key_revoked', targetId: keyId, targetType: 'api_key', metadata: { name: k.name, prefix: k.prefix } }], { session: tx });
    });
    return { success: true, data: { apiKey: this.view(await this.r.posApiKeyModel.findById(keyId).lean()) } };
  }

  /** Resolves a presented key (header) → its principal, or throws 401 / 403 / 429. Each accepted use is audited by [audit]. */
  async authenticate(raw: string | undefined, scope: ApiKeyScope, route: string, now = new Date()): Promise<ApiKeyPrincipal> {
    const m = KEY_RE.exec((raw ?? '').trim());
    if (!m) throw new UnauthorizedException({ statusCode: 401, code: 'API_KEY_INVALID', message: 'Send a valid API key in the X-Api-Key header' });
    const k: any = await this.r.posApiKeyModel.findOne({ prefix: m[1] }).lean();
    const a = Buffer.from(k?.secretHash ?? sha('x'), 'hex'); const b = Buffer.from(sha(m[2]), 'hex');
    if (!k || a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException({ statusCode: 401, code: 'API_KEY_INVALID', message: 'Send a valid API key in the X-Api-Key header' });
    const deny = async (code: string, message: string, status = 403) => {
      await this.audit(k, route, status, code);
      throw new HttpException({ statusCode: status, code, message }, status);
    };
    if (k.revokedAt) await deny('API_KEY_REVOKED', 'This key was revoked', 401);
    if (new Date(k.expiresAt) <= now) await deny('API_KEY_EXPIRED', 'This key has expired', 401);
    if (!k.scopes.includes(scope)) await deny('API_KEY_SCOPE', `This key does not have the ${scope} scope`);
    const window = Math.floor(now.getTime() / 60_000);
    const w: any = await this.r.posApiKeyWindowModel.findOneAndUpdate({ keyId: String(k._id), window }, { $inc: { count: 1 }, $setOnInsert: { expireAt: new Date((window + 2) * 60_000) } }, { upsert: true, new: true });
    if (w.count > apiKeyRatePerMinute()) await deny('API_KEY_RATE_LIMITED', `At most ${apiKeyRatePerMinute()} requests a minute per key`, 429);
    await this.r.posApiKeyModel.updateOne({ _id: k._id }, { $set: { lastUsedAt: now } });
    return { keyId: String(k._id), storeId: k.storeId, scopes: k.scopes, prefix: k.prefix };
  }

  /** One audit row per use (accepted ones after the response, refused ones at once). */
  async audit(k: { _id?: any; keyId?: string; storeId: string; prefix: string }, route: string, status: number, code: string | null = null, extra: Record<string, unknown> = {}) {
    try {
      await this.r.posAuditLogModel.create([{ storeId: k.storeId, employeeId: null, action: 'api_key_used', targetId: String(k.keyId ?? k._id), targetType: 'api_key', metadata: { prefix: k.prefix, route, status, code, ...extra } }]);
    } catch { /* the request result stands; a failed audit write is logged by mongoose */ }
  }
}

