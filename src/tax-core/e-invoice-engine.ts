/* eslint-disable prettier/prettier */
// Pure policy of the e-invoice engine: what to do with an authority's answer, and when a leased record is stale.
// No data, no database, no network. Country adapters feed it; the services apply what it decides.
import type { AuthorityResult } from './tax-authority.adapter';

export type EngineOutcome =
  | { kind: 'locked' }
  | { kind: 'submitted' }
  | { kind: 'auth_error' }
  | { kind: 'unknown_outcome' }
  | { kind: 'retry_later'; giveUp: boolean; delayMinutes: number }
  | { kind: 'rejected' };

export interface EngineContext {
  /** Tries made so far INCLUDING this one. */
  attempts: number;
  maxAttempts: number;
  /** Minutes to wait before try N+1. */
  retryDelayMinutes: (attemptsSoFar: number) => number;
}

/**
 * Order matters and is the duplicate-safety rule: a locked production call sends nothing; an accepted invoice is final; a bad token
 * is not retried; a possibly-delivered request (`unknownOutcome`) is NEVER retried by itself; only a request that provably never
 * left (`retryable`) is retried; everything else is a rejection.
 */
export function decideOutcome(r: AuthorityResult, ctx: EngineContext): EngineOutcome {
  if (r.locked) return { kind: 'locked' };
  if (r.ok && r.invoiceNumber) return { kind: 'submitted' };
  if (r.authError) return { kind: 'auth_error' };
  if (r.unknownOutcome) return { kind: 'unknown_outcome' };
  if (r.retryable) {
    const giveUp = ctx.attempts >= ctx.maxAttempts;
    return { kind: 'retry_later', giveUp, delayMinutes: giveUp ? 0 : ctx.retryDelayMinutes(ctx.attempts) };
  }
  return { kind: 'rejected' };
}

/** A record still "in flight" after the lease ran out lost its worker between sending and saving. */
export function isStaleInFlight(inFlightAt: Date | null | undefined, now: Date, staleMinutes: number): boolean {
  return !!inFlightAt && inFlightAt.getTime() <= now.getTime() - staleMinutes * 60_000;
}
