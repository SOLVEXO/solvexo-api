/* eslint-disable prettier/prettier */
import { AsyncLocalStorage } from 'async_hooks';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

/** Who is making the current HTTP request — set once per request (after the auth guards ran), readable anywhere below it. */
export interface RequestActor { userId: string; role: string; sellerId: string | null; /** Inside a bulk import: per-row log entries are dropped, the one summary entry is written instead. */ bulkImport?: boolean }

export const requestActor = new AsyncLocalStorage<RequestActor>();

/**
 * Many services log `actorId: sellerId` because they only receive the OWNING seller's id (a staff JWT is resolved to it by `actingSellerId`).
 * That made every staff action look like the owner did it. `resolveActor` swaps the owner for the real staff member when — and only when —
 * the current request was made by a staff member of exactly that owner.
 */
export function resolveActor<T extends { actorId?: string | null; actorRole?: string | null }>(data: T): T {
  const ctx = requestActor.getStore();
  if (!ctx || ctx.role !== 'staff' || !ctx.sellerId || !ctx.userId) return data;
  if (data.actorId && String(data.actorId) === String(ctx.sellerId)) {
    return { ...data, actorId: String(ctx.userId), actorRole: 'staff' };
  }
  return data;
}

/** Global: runs after the guards (so `req.user` is set) and keeps the actor available for the whole request, including awaited calls. */
@Injectable()
export class RequestActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest()?.user;
    if (!user) return next.handle();
    const ctx: RequestActor = { userId: String(user.userId ?? user.sub ?? ''), role: String(user.role ?? ''), sellerId: user.sellerId ? String(user.sellerId) : null };
    return new Observable((subscriber) => requestActor.run(ctx, () => next.handle().subscribe(subscriber)));
  }
}
