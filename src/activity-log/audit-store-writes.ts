/* eslint-disable prettier/prettier */
import { applyDecorators, CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata, UseInterceptors } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ActivityLogService } from './activity-log.service';
import { requestActor } from './activity-actor.context';
import { ActivityLogCategory } from './schemas/activity-log.schema';

export const AUDIT_STORE_META = 'audit:store-writes';

/** Verb for the LAST static route segment ("…/:pageId/publish" → published); falls back to the HTTP method. */
const SEGMENT_VERBS: Record<string, string> = {
  publish: 'published', unpublish: 'unpublished', activate: 'activated', deactivate: 'deactivated', duplicate: 'duplicated', install: 'installed',
  uninstall: 'uninstalled', restore: 'restored', 'revert-draft': 'draft_reverted', submit: 'submitted', approve: 'approved', reject: 'rejected',
  connect: 'connected', disconnect: 'disconnected', sync: 'synced', import: 'imported', export: 'exported', send: 'sent', 'preview-link': 'preview_link_created', complete: 'completed', pay: 'paid', confirm: 'confirmed', test: 'tested', toggle: 'toggled', enable: 'enabled', disable: 'disabled', 'auto-translate': 'auto_translated', 'webhook-secret': 'webhook_secret_rotated', 'opt-in': 'opted_in', 'opt-out': 'opted_out', 'bulk-archive': 'archived', 'bulk-marketing': 'bulk_marketing_updated', 'bulk-tag': 'bulk_tagged', 'erase-data': 'data_erased', 'save-builder-config': 'updated', 'update-store': 'updated',
};
const METHOD_VERBS: Record<string, string> = { POST: 'created', PUT: 'updated', PATCH: 'updated', DELETE: 'deleted' };
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|private|credential|authorization/i;

function verbFor(method: string, route: string): string {
  const statics = route.split('/').filter((s) => s && !s.startsWith(':') && !s.includes('*'));
  const last = statics[statics.length - 1];
  return SEGMENT_VERBS[last] ?? METHOD_VERBS[method] ?? method.toLowerCase();
}

/**
 * Writes one audit entry for every successful change (POST/PUT/PATCH/DELETE) a seller or staff member makes through the decorated controller.
 * Used for modules that had no activity logging of their own; modules that already log explicitly must NOT use it (it would double-log).
 * Records who, what, which entity, IP and device — plus the NAMES of the fields sent (never their values, so secrets can't leak).
 */
@Injectable()
export class StoreWriteAuditInterceptor implements NestInterceptor {
  constructor(private readonly activity: ActivityLogService, private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const method = String(req.method ?? '').toUpperCase();
    const user = req.user;
    const meta = this.reflector.getAllAndOverride<{ resource: string; category: ActivityLogCategory }>(AUDIT_STORE_META, [context.getHandler(), context.getClass()]);
    if (!meta || !METHOD_VERBS[method] || !user || !['seller', 'staff'].includes(user.role)) return next.handle();
    const storeId = String(req.params?.storeId ?? req.body?.storeId ?? req.query?.storeId ?? '');
    if (!/^[a-f0-9]{24}$/i.test(storeId)) return next.handle();

    const isImport = verbFor(method, String(req.route?.path ?? req.path ?? '')) === 'imported';
    const source: Observable<any> = isImport
      ? new Observable((subscriber) => requestActor.run({ userId: String(user.userId ?? user.sub ?? ''), role: String(user.role), sellerId: user.sellerId ? String(user.sellerId) : null, ...(requestActor.getStore() ?? {}), bulkImport: true }, () => next.handle().subscribe(subscriber)))
      : next.handle();
    return source.pipe(tap({
      next: (result: any) => {
        const route = String(req.route?.path ?? req.path ?? '');
        const verb = verbFor(method, route);
        const label = meta.resource.replace(/_/g, ' ');
        const targetId = Object.entries(req.params ?? {}).filter(([k]) => k !== 'storeId').map(([, v]) => String(v)).pop() ?? null;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const fields = Object.keys(body).filter((k) => !SECRET_KEY.test(k)).slice(0, 25);
        const hasSecret = Object.keys(body).some((k) => SECRET_KEY.test(k));
        // Bulk-import responses carry created/updated/skipped/failedCount — put the outcome in the entry.
        const r = [result, result?.data, result?.data?.result, result?.result].find((x) => x && typeof x === 'object' && typeof x.created === 'number');
        const summary = r ? ` — ${r.created} created, ${r.updated ?? 0} updated, ${r.skipped ?? 0} skipped, ${r.failedCount ?? 0} failed` : '';
        void this.activity.log({
          force: true,
          storeId, category: meta.category, action: `${meta.resource}_${verb}`,
          description: `${label.charAt(0).toUpperCase() + label.slice(1)} ${verb.replace(/_/g, ' ')}${fields.length && verb === 'updated' ? ` (${fields.join(', ')}${hasSecret ? ', credentials' : ''})` : ''}${summary}`,
          actorId: String(user.userId ?? user.sub ?? ''), actorRole: user.role, targetId, targetType: meta.resource,
          ip: req.ip, userAgent: req.headers?.['user-agent'] ?? null,
          metadata: fields.length || r ? { ...(fields.length ? { fields } : {}), ...(r ? { import: { created: r.created, updated: r.updated ?? 0, skipped: r.skipped ?? 0, failed: r.failedCount ?? 0 } } : {}) } : null,
        });
      },
    }));
  }
}

/** `@AuditStoreWrites('theme', 'settings')` on a seller/staff controller → every successful change lands in the store's activity log. */
export function AuditStoreWrites(resource: string, category: ActivityLogCategory = 'settings') {
  return applyDecorators(SetMetadata(AUDIT_STORE_META, { resource, category }), UseInterceptors(StoreWriteAuditInterceptor));
}
