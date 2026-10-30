import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { UploadService } from '../upload/upload.service';
import { DigitalAccessService } from './digital-access.service';

export const TOKEN_TTL_SECONDS = 300;
export const TOKENS_PER_HOUR = 30; // per customer
export const TOKENS_PER_IP_HOUR = 60;
export const MAX_CONCURRENT = 3;
export const IP_FLAG_THRESHOLD = 5; // distinct IPs / 24h

export type AbuseMode = 'off' | 'soft-flag' | 'block';
export interface Ctx { ip: string; userAgent: string }

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

@Injectable()
export class DigitalDeliveryService {
  private readonly logger = new Logger(DigitalDeliveryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly upload: UploadService,
    private readonly access: DigitalAccessService,
  ) {}

  private async log(storeId: string, customerId: string, productId: string | null, fileIndex: number | null, outcome: 'ok' | 'denied' | 'failed', reason: string, ctx: Ctx, flagged = false) {
    try {
      await this.access.logModel.create({ storeId, customerId, productId, fileIndex, outcome, reason, ip: ctx.ip, userAgent: (ctx.userAgent || '').slice(0, 200), flagged });
    } catch (e: any) {
      this.logger.warn(`delivery log failed: ${e?.message}`);
    }
  }

  private async abuseMode(storeId: string): Promise<AbuseMode> {
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId }).select('digitalAbuseMode').lean();
    const m = store?.digitalAbuseMode;
    return m === 'off' || m === 'block' ? m : 'soft-flag';
  }

  /** Step 1 (authenticated buyer): can() then mint a short-lived SINGLE-USE token. */
  async mintToken(storeId: string, customerId: string, productId: string, fileIndex: number, ctx: Ctx) {
    const rl = await this.redis.incrWithTtl(`dl:mint:c:${customerId}`, 3600);
    const rlIp = await this.redis.incrWithTtl(`dl:mint:ip:${ctx.ip}`, 3600);
    if (rl > TOKENS_PER_HOUR || rlIp > TOKENS_PER_IP_HOUR) {
      await this.log(storeId, customerId, productId, fileIndex, 'denied', 'rate_limited', ctx);
      throw new HttpException('Too many download requests, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }

    const gate = await this.access.can(storeId, customerId, { kind: 'file', ref: productId });
    if (!gate.allowed || !gate.access) {
      await this.log(storeId, customerId, productId, fileIndex, 'denied', gate.reason ?? 'no_access', ctx);
      throw new ForbiddenException('You do not have access to this file');
    }

    const product: any = await this.db.repositories.productModel.findOne({ _id: productId, storeId, isDelete: false }).select('digital').lean();
    const file = product?.digital?.files?.[fileIndex];
    if (!file || file.archived) {
      await this.log(storeId, customerId, productId, fileIndex, 'denied', 'file_unavailable', ctx);
      throw new NotFoundException('File not found');
    }
    if (file.requiresPlan) {
      // Plan gating arrives with memberships (M5); until then a plan-gated file is never served.
      await this.log(storeId, customerId, productId, fileIndex, 'denied', 'plan_required', ctx);
      throw new ForbiddenException('This file requires a membership');
    }
    const limit = product.digital.downloadLimit;
    if (limit && limit !== 'unlimited' && gate.access.downloadCount >= parseInt(limit, 10)) {
      await this.log(storeId, customerId, productId, fileIndex, 'denied', 'limit_reached', ctx);
      throw new ForbiddenException('Download limit reached');
    }

    const token = randomBytes(32).toString('hex');
    await this.redis.set(
      `dl:tok:${hash(token)}`,
      JSON.stringify({ storeId, customerId, productId, fileIndex, accessId: String(gate.access._id) }),
      TOKEN_TTL_SECONDS,
    );
    return { token, expiresInSeconds: TOKEN_TTL_SECONDS, fileName: file.name };
  }

  /**
   * Guest recovery: order number (or id) + the email used at checkout => a 30 minute recovery
   * token that can list the library and mint download tokens for THAT customer in THAT store.
   * Same answer whether or not the order exists (no enumeration); 5 tries / hour / IP.
   */
  async recoverGuest(storeId: string, orderRef: string, email: string, ctx: Ctx) {
    const tries = await this.redis.incrWithTtl(`dl:rec:${ctx.ip}`, 3600);
    if (tries > 5) throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    const ref = String(orderRef ?? '').trim().slice(0, 40);
    const mail = String(email ?? '').trim().toLowerCase().slice(0, 200);
    const miss = new NotFoundException('We could not find a matching order');
    if (!ref || !mail || !storeId) throw miss;
    const { orderModel, userModel } = this.db.repositories as any;
    const order: any = await orderModel
      .findOne({ $or: [{ orderNumber: ref }, ...(/^[a-f0-9]{24}$/i.test(ref) ? [{ _id: ref }] : [])], isPaid: true, isDelete: false, 'sellerOrders.storeId': storeId })
      .lean();
    if (!order) throw miss;
    const user: any = await userModel.findOne({ _id: order.userId }).select('email contactEmail').lean();
    const ok = [user?.email, user?.contactEmail].filter(Boolean).some((e: string) => String(e).toLowerCase() === mail);
    if (!ok) throw miss;
    const token = randomBytes(32).toString('hex');
    await this.redis.set(`dl:recov:${hash(token)}`, JSON.stringify({ storeId, customerId: String(order.userId) }), 1800);
    return { recoveryToken: token, expiresInSeconds: 1800 };
  }

  async resolveRecovery(token: string): Promise<{ storeId: string; customerId: string }> {
    if (!token || typeof token !== 'string' || token.length > 200) throw new ForbiddenException('Invalid recovery link');
    const raw = await this.redis.get(`dl:recov:${hash(token)}`);
    if (!raw) throw new ForbiddenException('Recovery link expired');
    return JSON.parse(raw);
  }

  /** Step 2 (token only, no JWT): single use. Re-checks can(), concurrency, limit, anomalies. */
  async redeem(token: string, ctx: Ctx): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    if (!token || typeof token !== 'string' || token.length > 200) throw new BadRequestException('Invalid link');
    const raw = await this.redis.getDel(`dl:tok:${hash(token)}`); // atomic: a second use gets null
    if (!raw) throw new BadRequestException('Download link expired or already used');
    const { storeId, customerId, productId, fileIndex, accessId } = JSON.parse(raw);

    const gate = await this.access.can(storeId, customerId, { kind: 'file', ref: productId });
    if (!gate.allowed || !gate.access || String(gate.access._id) !== accessId) {
      await this.log(storeId, customerId, productId, fileIndex, 'denied', gate.reason ?? 'access_changed', ctx);
      throw new ForbiddenException('You do not have access to this file');
    }

    // anomaly: many distinct IPs for one customer in 24h (never a single-IP rule: shared / CGNAT IPs)
    let flagged = false;
    const mode = await this.abuseMode(storeId);
    if (mode !== 'off') {
      const first = await this.redis.incrWithTtl(`dl:ip:${customerId}:${hash(ctx.ip)}`, 86400);
      if (first === 1) {
        const distinct = await this.redis.incrWithTtl(`dl:ips:${customerId}`, 86400);
        if (distinct >= IP_FLAG_THRESHOLD) flagged = true;
      }
      if (flagged) {
        await this.access.accessModel.updateOne({ _id: accessId }, { $set: { flagged: true }, $push: { audit: { at: new Date(), action: 'flagged', by: 'system', note: 'many distinct IPs in 24h' } } });
        if (mode === 'block') {
          await this.log(storeId, customerId, productId, fileIndex, 'denied', 'anomaly_blocked', ctx, true);
          throw new ForbiddenException('Downloads paused for this account, contact the store');
        }
      }
    }

    const concKey = `dl:conc:${customerId}`;
    const running = await this.redis.incrWithTtl(concKey, 120);
    try {
      if (running > MAX_CONCURRENT) {
        await this.log(storeId, customerId, productId, fileIndex, 'denied', 'too_many_concurrent', ctx, flagged);
        throw new HttpException('Too many downloads at once', HttpStatus.TOO_MANY_REQUESTS);
      }

      const product: any = await this.db.repositories.productModel.findOne({ _id: productId, storeId }).select('digital').lean();
      const file = product?.digital?.files?.[fileIndex];
      if (!file || file.archived) throw new NotFoundException('File not found');

      // atomic limit claim
      const limit = product.digital.downloadLimit;
      const cond: any = { _id: accessId, status: 'active' };
      if (limit && limit !== 'unlimited') cond.downloadCount = { $lt: parseInt(limit, 10) };
      const claimed = await this.access.accessModel.updateOne(cond, { $inc: { downloadCount: 1 } });
      if (!claimed.modifiedCount) {
        await this.log(storeId, customerId, productId, fileIndex, 'denied', 'limit_reached', ctx, flagged);
        throw new ForbiddenException('Download limit reached');
      }

      const mimeType = this.upload.resolveMimeType(file.name, file.mimeType ?? 'application/octet-stream');
      const resourceType = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('image/') ? 'image' : 'raw';
      try {
        const res = await fetch(this.upload.generateSignedUrl(file.url, resourceType, 300));
        if (!res.ok) throw new Error(`storage ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        await this.log(storeId, customerId, productId, fileIndex, 'ok', '', ctx, flagged);
        return { buffer, fileName: file.name, mimeType };
      } catch (e: any) {
        // give the unused download back
        await this.access.accessModel.updateOne({ _id: accessId, downloadCount: { $gt: 0 } }, { $inc: { downloadCount: -1 } });
        await this.log(storeId, customerId, productId, fileIndex, 'failed', String(e?.message ?? 'storage_error').slice(0, 100), ctx, flagged);
        throw new BadRequestException('Failed to fetch file from storage');
      }
    } finally {
      await this.redis.decr(concKey).catch(() => undefined);
    }
  }
}
