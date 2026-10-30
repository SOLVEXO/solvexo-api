import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { LicenseKey, LicenseKeyDocument } from './license.schema';
import { generateLicenseKey, hashDevice, hashKey, hashToken, isWellFormedKey, safeEqualHex } from './license-key.util';

const DEAD_ITEM = ['cancelled', 'refunded'];
const MAX_ATTEMPTS_PER_HOUR = 30; // per store token + per IP

export interface Ctx { ip: string }

@Injectable()
export class LicensesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    @InjectModel(LicenseKey.name) readonly keyModel: Model<LicenseKeyDocument>,
  ) {}

  // ---------------- issuing ----------------

  /** One key per paid digital order item of a product that has license keys switched on. Idempotent (unique orderItemId). */
  async ensureFromOrders(storeId: string, customerId: string): Promise<void> {
    const { orderModel, productModel } = this.db.repositories;
    const orders = await orderModel.find({ userId: customerId, isPaid: true, isDelete: false, 'sellerOrders.storeId': storeId }).limit(200).lean();
    for (const o of orders as any[]) {
      for (const so of o.sellerOrders ?? []) {
        if (so.storeId !== storeId) continue;
        for (const item of so.items ?? []) {
          if (item.type !== 'digital' || DEAD_ITEM.includes(item.status)) continue;
          const p: any = await productModel.findOne({ _id: item.productId, storeId }).select('digital').lean();
          const cfg = p?.digital?.licenseKeys;
          if (!cfg?.enabled) continue;
          const exists = await this.keyModel.exists({ storeId, orderItemId: String(item._id) });
          if (exists) continue;
          const key = generateLicenseKey();
          try {
            await this.keyModel.create({
              storeId, productId: String(item.productId), customerId, orderId: String(o._id), orderItemId: String(item._id),
              keyHash: hashKey(key), keyEnc: encryptCredential(key, 'INTEGRATIONS'), keyHint: key.slice(-4),
              activationLimit: Number(cfg.activationLimit) > 0 ? Number(cfg.activationLimit) : 1,
            });
          } catch (e: any) {
            if (e?.code !== 11000) throw e; // a parallel call created it first
          }
        }
      }
    }
  }

  /** An item that was cancelled / refunded kills its key (checked on every validation too). */
  private async itemAlive(k: LicenseKeyDocument): Promise<boolean> {
    const o: any = await this.db.repositories.orderModel.findOne({ _id: k.orderId, isDelete: false }).lean();
    const it = o?.sellerOrders?.flatMap((s: any) => s.items).find((i: any) => String(i._id) === k.orderItemId);
    return !!it && !DEAD_ITEM.includes(it.status);
  }

  // ---------------- buyer ----------------

  async listMine(storeId: string, customerId: string) {
    await this.ensureFromOrders(storeId, customerId);
    const rows = await this.keyModel.find({ storeId, customerId, status: 'active' }).select('+keyEnc').lean();
    const out: any[] = [];
    for (const r of rows) {
      if (!(await this.itemAlive(r as any))) continue;
      out.push({ id: String(r._id), productId: r.productId, key: decryptCredential(r.keyEnc, 'INTEGRATIONS'), activationLimit: r.activationLimit, activations: r.activations.length });
    }
    return out;
  }

  // ---------------- seller ----------------

  async newApiToken(storeId: string): Promise<{ token: string }> {
    const token = `lk_${randomBytes(24).toString('hex')}`;
    await this.db.repositories.storeModel.updateOne({ _id: storeId }, { $set: { licenseApiTokenHash: hashToken(token) } });
    return { token }; // shown once; only the hash is stored
  }

  async listForStore(storeId: string, limit = 50) {
    const rows = await this.keyModel.find({ storeId }).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).lean();
    return rows.map((r) => ({ id: String(r._id), productId: r.productId, customerId: r.customerId, orderId: r.orderId, keyHint: r.keyHint, status: r.status, activationLimit: r.activationLimit, activations: r.activations.length, createdAt: (r as any).createdAt }));
  }

  private async forStore(storeId: string, id: string) {
    const k = await this.keyModel.findOne({ _id: id, storeId }).catch(() => null);
    if (!k) throw new NotFoundException('License not found');
    return k;
  }

  async sellerRevoke(storeId: string, id: string) { const k = await this.forStore(storeId, id); k.status = 'revoked'; await k.save(); return { success: true }; }
  async sellerResetActivations(storeId: string, id: string) { const k = await this.forStore(storeId, id); k.activations = []; await k.save(); return { success: true }; }

  // ---------------- public API (per-store token) ----------------

  private async storeFromToken(token: string, ctx: Ctx): Promise<string> {
    if (typeof token !== 'string' || !/^lk_[a-f0-9]{48}$/.test(token)) throw new UnauthorizedException('Invalid API token');
    const hits = await this.redis.incrWithTtl(`lic:ip:${ctx.ip}`, 3600);
    if (hits > MAX_ATTEMPTS_PER_HOUR * 4) throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    const th = hashToken(token);
    const store: any = await this.db.repositories.storeModel.findOne({ licenseApiTokenHash: th, isDelete: false }).select('+licenseApiTokenHash').lean();
    if (!store || !safeEqualHex(store.licenseApiTokenHash, th)) throw new UnauthorizedException('Invalid API token');
    return String(store._id);
  }

  private async load(storeId: string, rawKey: string) {
    if (!isWellFormedKey(rawKey)) return null;
    const hits = await this.redis.incrWithTtl(`lic:key:${storeId}:${hashKey(rawKey).slice(0, 16)}`, 3600);
    if (hits > MAX_ATTEMPTS_PER_HOUR) throw new HttpException('Too many requests for this key', HttpStatus.TOO_MANY_REQUESTS);
    const k = await this.keyModel.findOne({ storeId, keyHash: hashKey(rawKey) });
    if (!k || !safeEqualHex(k.keyHash, hashKey(rawKey))) return null;
    return k;
  }

  /** Same response for unknown / revoked / refunded keys: valid=false, no reason that helps a guesser. */
  async validate(token: string, body: { key: string; deviceId?: string; activate?: boolean }, ctx: Ctx) {
    const storeId = await this.storeFromToken(token, ctx);
    const st: any = await this.db.repositories.storeModel.findOne({ _id: storeId }).select('digitalDisabled').lean();
    if (st?.digitalDisabled) return { valid: false };
    const k = await this.load(storeId, body?.key);
    if (!k || k.status !== 'active' || !(await this.itemAlive(k))) return { valid: false };
    let activated = false;
    if (body.activate) {
      if (!body.deviceId) throw new BadRequestException('deviceId is required to activate');
      const dh = hashDevice(storeId, body.deviceId);
      const now = new Date();
      const known = k.activations.find((a) => a.deviceHash === dh);
      if (known) { known.lastSeen = now; activated = true; await k.save(); }
      else {
        // atomic: only add while below the limit
        const r = await this.keyModel.updateOne(
          { _id: k._id, status: 'active', [`activations.${k.activationLimit - 1}`]: { $exists: false }, 'activations.deviceHash': { $ne: dh } },
          { $push: { activations: { deviceHash: dh, ip: ctx.ip, firstSeen: now, lastSeen: now } } },
        );
        if (!r.modifiedCount) return { valid: true, activated: false, reason: 'activation_limit_reached', activationsLeft: 0, activationLimit: k.activationLimit };
        activated = true;
      }
    }
    const fresh = await this.keyModel.findById(k._id).lean();
    const used = fresh?.activations.length ?? 0;
    return { valid: true, activated, activationLimit: k.activationLimit, activationsLeft: Math.max(0, k.activationLimit - used) };
  }

  async deactivate(token: string, body: { key: string; deviceId: string }, ctx: Ctx) {
    const storeId = await this.storeFromToken(token, ctx);
    if (!body?.deviceId) throw new BadRequestException('deviceId is required');
    const k = await this.load(storeId, body?.key);
    if (!k) return { success: true }; // never reveal whether the key exists
    await this.keyModel.updateOne({ _id: k._id }, { $pull: { activations: { deviceHash: hashDevice(storeId, body.deviceId) } } });
    return { success: true };
  }
}
