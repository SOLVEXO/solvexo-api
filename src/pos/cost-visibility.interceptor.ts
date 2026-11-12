/* eslint-disable prettier/prettier */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, mergeMap } from 'rxjs';
import { DatabaseService } from '@/database/databaseservice';
import { PosAuthorizer } from './pos-authorizer.service';
import { carriesCost, costKeysFor, stripCost } from './cost-visibility.registry';

/**
 * G4.8 — "hide costs from managers" (store security setting, default off), enforced ONCE for every POS response:
 *   when the response carries a registered cost field (cost-visibility.registry.ts), the caller is not the store's owner and the store has the setting on,
 *   the cost fields are removed and `data.costsHidden = true` is added (so the app shows a notice instead of zeros). Reports always get the flag when hidden.
 * Responses without cost fields are never touched (no database read). Registered globally (APP_INTERCEPTOR) but acts on `/api/pos/` routes only.
 */
@Injectable()
export class CostVisibilityInterceptor implements NestInterceptor {
  constructor(private readonly db: DatabaseService, private readonly auth: PosAuthorizer) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    if (ctx.getType() !== 'http') return next.handle();
    const req: any = ctx.switchToHttp().getRequest();
    const path = String(req?.originalUrl ?? req?.url ?? '').split('?')[0];
    if (!path.startsWith('/api/pos/')) return next.handle();
    return next.handle().pipe(mergeMap((body) => from(this.apply(req, path, body))));
  }

  /** Public for tests: the response as the caller may see it. */
  async apply(req: any, path: string, body: any): Promise<any> {
    const keys = costKeysFor(path);
    const isReport = path.startsWith('/api/pos/reports/');
    if (!body || typeof body !== 'object' || (!isReport && !carriesCost(body, keys))) return body;
    const storeId = this.storeOf(req, body);
    if (!storeId) return body;
    if (!(await this.hidden(req, storeId))) return body;
    const out: any = carriesCost(body, keys) ? stripCost(body, keys) : JSON.parse(JSON.stringify(body));
    if (out.data && typeof out.data === 'object' && !Array.isArray(out.data)) out.data.costsHidden = true;
    else out.costsHidden = true;
    return out;
  }

  private storeOf(req: any, body: any): string | null {
    const pick = (v: any) => (typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) ? v : null);
    return pick(req?.params?.storeId) ?? pick(req?.query?.storeId) ?? pick(req?.body?.storeId) ?? pick(body?.data?.storeId) ?? pick(body?.storeId) ?? pick(req?.user?.posDevice?.storeId);
  }

  /** Is cost hidden for this caller in this store? The owner always sees cost. */
  private async hidden(req: any, storeId: string): Promise<boolean> {
    const s: any = await this.db.repositories.posSettingsModel.findOne({ storeId }).select('securityPrefs').lean();
    if (s?.securityPrefs?.hideCostsFromManagers !== true) return false;
    const who = await this.auth.roleOf(req, storeId, req?.headers?.['x-pos-employee-token']);
    return who.role !== 'owner';
  }
}
