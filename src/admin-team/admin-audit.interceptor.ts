import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ActivityLogService } from '../activity-log/activity-log.service';

/** Global audit trail: every CHANGE (POST/PUT/PATCH/DELETE) made by an admin is written to the activity log with
 *  who, what route, from which IP, and whether it succeeded. Reading is not logged (it would drown the log). */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly activity: ActivityLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const method = String(req.method ?? '').toUpperCase();
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const user = req.user;
    // Real admin sessions only: "view as store" tokens are staff-shaped (read-only, logged when opened).
    if (!isWrite || !user || user.role !== 'admin') return next.handle();

    const route = String(req.route?.path ?? req.path ?? '');
    // The team endpoints log their own, more descriptive, entries.
    if (route.includes('/admin/team')) return next.handle();
    const res = context.switchToHttp().getResponse();
    const log = (ok: boolean) => this.activity.log({
      category: 'admin_audit', action: `${method} ${route}`, description: `${ok ? '' : 'FAILED: '}${method} ${req.originalUrl?.split('?')[0] ?? route}`,
      actorId: user.userId, actorName: user.email ?? null, actorRole: 'admin', targetType: 'route', ip: req.ip, userAgent: req.headers?.['user-agent'] ?? null,
      metadata: { status: res?.statusCode, teamAdmin: user.teamAdmin === true },
    });
    return next.handle().pipe(tap({ next: () => { void log(true); }, error: () => { void log(false); } }));
  }
}
