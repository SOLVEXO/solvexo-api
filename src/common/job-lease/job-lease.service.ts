/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { JobLease, JobLeaseDocument } from './job-lease.schema';

export interface Lease { key: string; token: string; epoch: number; ttlMs: number }
export interface LeaseContext {
  lease: Lease;
  /** False once a heartbeat failed to renew (the lease expired and may belong to someone else): stop doing new work. */
  isValid(): boolean;
}
export const BUSY = Symbol('LEASE_BUSY');

/**
 * Distributed lease in MongoDB (no new package). `tryAcquire` succeeds only if no unexpired lease exists; the holder renews with a
 * heartbeat while it works (`withLease`) and releases when done. If a holder dies or stalls past the TTL, someone else takes over — so
 * everything that runs under a lease MUST stay idempotent (all payment / KYB writes are: unique keys, guarded updates), because a stalled
 * holder can wake up after its lease was taken.
 */
@Injectable()
export class JobLeaseService {
  private readonly logger = new Logger(JobLeaseService.name);
  readonly instance = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

  constructor(@InjectModel(JobLease.name) readonly model: Model<JobLeaseDocument>) {}

  async tryAcquire(key: string, ttlMs: number): Promise<Lease | null> {
    const token = randomBytes(12).toString('hex');
    // ONE atomic statement per attempt; $$NOW is the database's clock. The row always matches by _id (upsert creates it); the pipeline
    // takes the lease over ONLY IF the current one is expired (or the row is new) and otherwise leaves the holder's fields untouched.
    // We own the lease iff the stored token is ours afterwards. (An upsert may not carry an $expr filter, hence the conditional pipeline.)
    const expired = { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, '$$NOW'] };
    const take = (mine: any, theirs: any) => ({ $cond: [expired, mine, theirs] });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc: any = await this.model.collection.findOneAndUpdate(
          { _id: key as any },
          [{ $set: {
            epoch: take({ $add: [{ $ifNull: ['$epoch', 0] }, 1] }, '$epoch'),
            owner: take(this.instance, '$owner'),
            acquiredAt: take('$$NOW', '$acquiredAt'),
            expiresAt: take({ $add: ['$$NOW', ttlMs] }, '$expiresAt'),
            token: take(token, '$token'),
          } }],
          { upsert: true, returnDocument: 'after' },
        );
        const row = doc?.value ?? doc; // driver versions differ in the wrapper
        return row && row.token === token ? { key, token, epoch: row.epoch, ttlMs } : null;
      } catch (e: any) {
        if (e?.code === 11000) continue; // two first-ever acquirers raced on the insert: the loser simply tries again as an update
        throw e;
      }
    }
    return null;
  }

  /** Extends a lease we still hold. False = we lost it (expired and taken over, or released). */
  async renew(lease: Lease, ttlMs = lease.ttlMs): Promise<boolean> {
    const r = await this.model.collection.updateOne({ _id: lease.key as any, token: lease.token, $expr: { $gt: ['$expiresAt', '$$NOW'] } }, [{ $set: { expiresAt: { $add: ['$$NOW', ttlMs] } } }]);
    return r.matchedCount === 1;
  }

  /** Releases a lease we hold (a no-op if someone else holds it now). */
  async release(lease: Lease): Promise<void> {
    // expire it (keep the row so the fencing epoch keeps counting); housekeeping TTL removes long-dead rows
    await this.model.collection.updateOne({ _id: lease.key as any, token: lease.token }, { $set: { expiresAt: new Date(0) } });
  }

  /**
   * Runs `fn` only if the lease is free, keeping it alive with a heartbeat every ttl/3 and releasing it afterwards (also on error).
   * Returns `BUSY` when someone else holds it. `fn` receives a context whose `isValid()` turns false if the heartbeat lost the lease.
   */
  async withLease<T>(key: string, ttlMs: number, fn: (ctx: LeaseContext) => Promise<T>): Promise<T | typeof BUSY> {
    const lease = await this.tryAcquire(key, ttlMs);
    if (!lease) return BUSY;
    let valid = true;
    const timer = setInterval(() => { this.renew(lease).then((ok) => { if (!ok) valid = false; }, () => { /* a transient DB error: try again next beat */ }); }, Math.max(100, Math.floor(ttlMs / 3)));
    timer.unref?.();
    try { return await fn({ lease, isValid: () => valid }); }
    finally { clearInterval(timer); await this.release(lease).catch((e) => this.logger.warn(`lease release failed for ${key}: ${e?.message}`)); }
  }
}
