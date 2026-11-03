/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';

const TOKEN_TTL_S = 13 * 3600; // employee tokens live 12h — a revocation record only has to outlive them

/**
 * Server-side revocation for POS employee tokens (JWT, 12h). Backed by Redis so it is shared across instances:
 *  - one token  (pin-logout)                         → `pos:emp-jti:{jti}`
 *  - every token of an employee issued before "now"  → `pos:emp-before:{employeeId}`  (deactivation, PIN reset, lockout)
 * An offline sale replayed later is judged "as of the sale time": a revocation only counts if it had ALREADY happened
 * when the sale was made (a logout that came after the sale does not invalidate the sale's manager approval).
 * Redis unavailable → fail open (same stance as JwtAuthGuard); the token's own signature/expiry still apply.
 */
@Injectable()
export class PosTokenRevocationService {
  constructor(private readonly redis: RedisService) {}

  async revokeToken(jti: string | undefined | null): Promise<void> {
    if (!jti) return;
    await this.redis.set(`pos:emp-jti:${jti}`, String(Date.now()), TOKEN_TTL_S).catch(() => {});
  }

  async revokeEmployee(employeeId: string): Promise<void> {
    await this.redis.set(`pos:emp-before:${employeeId}`, String(Date.now()), TOKEN_TTL_S).catch(() => {});
  }

  /** `at` = the time the token was USED (default: now). */
  async isRevoked(payload: { jti?: string; employeeId: string; iat?: number; iatMs?: number }, at?: Date): Promise<boolean> {
    try {
      const [byJti, before] = await Promise.all([
        payload.jti ? this.redis.get(`pos:emp-jti:${payload.jti}`) : Promise.resolve(null),
        this.redis.get(`pos:emp-before:${payload.employeeId}`),
      ]);
      const issuedMs = payload.iatMs ?? (payload.iat ?? 0) * 1000 + 999;
      const hits: number[] = [];
      if (byJti) hits.push(Number(byJti));
      if (before && Number(before) >= issuedMs) hits.push(Number(before)); // only tokens issued BEFORE the revocation
      if (hits.length === 0) return false;
      if (!at) return true;
      return Math.min(...hits) <= at.getTime(); // offline replay: revoked only if it was already revoked at the sale time
    } catch {
      return false;
    }
  }

  // ── PIN guessing, per DEVICE (the per-employee lockout in PosService stops one account being ground down; this stops a
  //    stolen/rooted terminal cycling through every employee and PIN) ────────────────────────────────────────────────
  static readonly PIN_MAX_FAILURES = 25;
  static readonly PIN_WINDOW_S = 10 * 60;

  /** Seconds until a limited caller may try again, or 0 when not limited. */
  async pinRetryAfter(scopeKey: string): Promise<number> {
    try {
      const k = `pos:pin-rl:${scopeKey}`;
      const n = Number((await this.redis.get(k)) ?? 0);
      if (n < PosTokenRevocationService.PIN_MAX_FAILURES) return 0;
      return PosTokenRevocationService.PIN_WINDOW_S;
    } catch { return 0; }
  }

  async notePinFailure(scopeKey: string): Promise<void> {
    await this.redis.incrWithTtl(`pos:pin-rl:${scopeKey}`, PosTokenRevocationService.PIN_WINDOW_S).catch(() => {});
  }

  async clearPinFailures(scopeKey: string): Promise<void> {
    await this.redis.del(`pos:pin-rl:${scopeKey}`).catch(() => {});
  }
}
