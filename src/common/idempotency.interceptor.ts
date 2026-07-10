/* eslint-disable prettier/prettier */
import {
  CallHandler, ConflictException, ExecutionContext, Injectable,
  NestInterceptor, Logger,
} from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap, catchError } from 'rxjs/operators';
import { DatabaseService } from 'src/database/databaseservice';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — comfortably covers any realistic client retry window

/**
 * Enforces `Idempotency-Key` header semantics (Stripe-style) on mutating
 * endpoints: money-moving actions (subscribe, change-plan) must never be
 * double-executed because a mobile client retried a timed-out request.
 *
 * No header present → fully transparent no-op (100% backward compatible with
 * every existing caller that doesn't send one yet).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly db: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const rawKey = request.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string') {
      return next.handle();
    }

    const requesterId = request.user?.userId ?? 'anonymous';
    const storedKey = `${requesterId}:${request.method}:${request.route?.path ?? request.url}:${rawKey}`;
    const model = this.db.repositories.idempotencyRecordModel;

    return from(this.claim(model, storedKey, requesterId, request.originalUrl ?? request.url)).pipe(
      switchMap((claim) => {
        if (claim.status === 'cached') {
          return of(claim.record.responseBody);
        }
        if (claim.status === 'in_progress_conflict') {
          throw new ConflictException('A request with this Idempotency-Key is already being processed');
        }
        // claim.status === 'claimed' — proceed with the real handler
        return next.handle().pipe(
          tap((responseBody) => {
            model.updateOne(
              { key: storedKey },
              { $set: { status: 'completed', responseStatusCode: 200, responseBody: responseBody ?? null } },
            ).catch((err) => this.logger.warn(`Failed to persist idempotency result for ${storedKey}: ${err?.message}`));
          }),
          catchError((err) => {
            // Failed attempts don't get cached — the client is allowed to retry
            // the same key once whatever caused the failure is resolved.
            model.deleteOne({ key: storedKey }).catch(() => {});
            throw err;
          }),
        );
      }),
    );
  }

  private async claim(model: any, storedKey: string, requesterId: string, route: string) {
    const existing = await model.findOne({ key: storedKey }).lean();
    if (existing?.status === 'completed') {
      return { status: 'cached' as const, record: existing };
    }
    if (existing?.status === 'in_progress') {
      return { status: 'in_progress_conflict' as const, record: existing };
    }

    try {
      await model.create({
        key: storedKey, requesterId, route, status: 'in_progress',
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      });
      return { status: 'claimed' as const, record: null };
    } catch (err: any) {
      // Duplicate-key race — another concurrent request with the same key won the insert.
      if (err?.code === 11000) {
        return { status: 'in_progress_conflict' as const, record: null };
      }
      throw err;
    }
  }
}
