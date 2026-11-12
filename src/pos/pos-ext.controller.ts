/* eslint-disable prettier/prettier */
import { BadRequestException, CallHandler, CanActivate, Controller, ExecutionContext, Get, Injectable, NestInterceptor, Query, Req, Res, SetMetadata, UseGuards, UseInterceptors } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { isoExponent, toMinor } from '@/common/money-minor.util';
import { PosApiKeysService } from './pos-api-keys.service';
import { PosReportsService } from './pos-reports.service';
import { ApiKeyScope } from './schemas/pos-api-key.schema';

const SCOPE = 'posApiKeyScope';
export const RequireApiKeyScope = (s: ApiKeyScope) => SetMetadata(SCOPE, s);

/** G5.7: the key in `X-Api-Key` must be valid, live, have the route's scope and be under its per-minute limit. */
@Injectable()
export class PosApiKeyGuard implements CanActivate {
  constructor(private readonly keys: PosApiKeysService, private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const scope = this.reflector.get<ApiKeyScope>(SCOPE, ctx.getHandler());
    req.apiKey = await this.keys.authenticate(req.headers?.['x-api-key'], scope, `${req.method} ${req.route?.path ?? req.path}`);
    return true;
  }
}

/** G5.7: every accepted use → one audit row with the outcome. */
@Injectable()
export class PosApiKeyAuditInterceptor implements NestInterceptor {
  constructor(private readonly keys: PosApiKeysService) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest(); const res = ctx.switchToHttp().getResponse();
    const k = req.apiKey; const route = `${req.method} ${req.route?.path ?? req.path}`;
    const q = { from: req.query?.from ?? null, to: req.query?.to ?? null };
    return next.handle().pipe(
      tap(() => { if (k) void this.keys.audit(k, route, res.statusCode ?? 200, null, q); }),
      catchError((e) => { if (k) void this.keys.audit(k, route, e?.status ?? 500, e?.response?.code ?? null, q); return throwError(() => e); }),
    );
  }
}

/**
 * G5.7 — the read-only API for a store's own systems (accounting, BI). Authenticated by a store API key (owner-issued, scoped, expiring, revocable,
 * rate-limited, every use audited). Money in minor units with currency + exponent. NO cost data on any route. Documented in API_KEYS.md.
 */
@ApiTags('POS external API (read-only)')
@ApiHeader({ name: 'X-Api-Key', required: true, description: 'sxk_… store API key' })
@UseGuards(PosApiKeyGuard)
@UseInterceptors(PosApiKeyAuditInterceptor)
@Controller('api/pos/ext/v1')
export class PosExtController {
  constructor(private readonly db: DatabaseService, private readonly reports: PosReportsService) {}
  private repos(): any { return this.db.repositories; }

  private async money(storeId: string) {
    const s: any = await this.repos().storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = String(s?.baseCurrency || 'USD').toUpperCase();
    return { currency, currencyExponent: isoExponent(currency) };
  }
  private range(q: any) {
    const to = q?.to ? new Date(q.to) : new Date();
    const from = q?.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new BadRequestException({ statusCode: 400, code: 'RANGE_INVALID', message: 'from / to must be ISO dates, from before to' });
    if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new BadRequestException({ statusCode: 400, code: 'RANGE_TOO_LONG', message: 'At most 92 days per request' });
    return { from, to };
  }
  private limit(q: any) { return Math.min(Math.max(Number(q?.limit) || 100, 1), 500); }

  /** Completed / refunded / voided sales in [from, to) (by sale time), oldest first, `cursor` = the last id of the previous page. */
  @RequireApiKeyScope('sales:read') @Get('sales')
  async sales(@Req() req: any, @Query() q: any) {
    const storeId = req.apiKey.storeId; const { from, to } = this.range(q); const limit = this.limit(q);
    const m: any = { storeId, createdAt: { $gte: from, $lt: to }, status: { $nin: ['held', 'discarded'] } };
    if (q?.cursor && Types.ObjectId.isValid(q.cursor)) m._id = { $gt: new Types.ObjectId(String(q.cursor)) };
    const rows: any[] = await this.repos().saleModel.find(m).sort({ _id: 1 }).limit(limit + 1).select('saleNumber invoice.number createdAt status items payments paymentMethod subtotal total tax totalMinor taxMinor currency currencyExponent customerName registerId').lean();
    const page = rows.slice(0, limit);
    const mc = await this.money(storeId);
    return {
      success: true,
      data: {
        ...mc,
        sales: page.map((x) => {
          const exp = x.currencyExponent ?? mc.currencyExponent;
          return {
            id: String(x._id), saleNumber: x.saleNumber, invoiceNumber: x.invoice?.number ?? null, createdAt: x.createdAt, status: x.status, registerId: x.registerId ?? null, customerName: x.customerName ?? null,
            currency: x.currency ?? mc.currency, currencyExponent: exp,
            totalMinor: x.totalMinor ?? toMinor(x.total ?? 0, exp), taxMinor: x.taxMinor ?? toMinor(x.tax ?? 0, exp),
            payments: (x.payments?.length ? x.payments : [{ method: x.paymentMethod, amount: x.total }]).map((p: any) => ({ method: p.method, amountMinor: p.amountMinor ?? toMinor(p.amount ?? 0, exp) })),
            items: (x.items ?? []).map((i: any) => ({ productId: i.productId ?? null, variantId: i.variantId ?? null, name: i.name, sku: i.sku ?? null, qty: i.qty, refundedQty: i.refundedQty ?? 0, netMinor: i.netMinor ?? null, taxMinor: i.taxMinor ?? null })),
          };
        }),
        nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
      },
    };
  }

  /** Every sellable variant of the store with its on-hand stock and price (no cost). */
  @RequireApiKeyScope('inventory:read') @Get('inventory')
  async inventory(@Req() req: any, @Query() q: any) {
    const storeId = req.apiKey.storeId; const limit = this.limit(q);
    const pm: any = { storeId, isDelete: { $ne: true } };
    if (q?.cursor && Types.ObjectId.isValid(q.cursor)) pm._id = { $gt: new Types.ObjectId(String(q.cursor)) };
    const products: any[] = await this.repos().productModel.find(pm).sort({ _id: 1 }).limit(limit + 1).select('name type categoryId').lean();
    const page = products.slice(0, limit);
    const variants: any[] = page.length ? await this.repos().productVariantModel.find({ productId: { $in: page.map((p) => String(p._id)) } }).select('productId sku barcode price stock committedStock unlimitedStock reorderPoint currency').lean() : [];
    const mc = await this.money(storeId);
    return {
      success: true,
      data: {
        ...mc,
        products: page.map((p) => ({
          id: String(p._id), name: p.name, type: p.type ?? null, categoryId: p.categoryId ?? null,
          variants: variants.filter((v) => String(v.productId) === String(p._id)).map((v) => ({ id: String(v._id), sku: v.sku, barcode: v.barcode ?? null, priceMinor: toMinor(v.price ?? 0, mc.currencyExponent), stock: v.unlimitedStock ? null : (v.stock ?? 0), committedStock: v.committedStock ?? 0, unlimitedStock: !!v.unlimitedStock, reorderPoint: v.reorderPoint ?? null })),
        })),
        nextCursor: products.length > limit ? String(page[page.length - 1]._id) : null,
      },
    };
  }

  /** The accounting CSV (store time zone, minor units + formatted amounts) — never with cost columns through a key. */
  @RequireApiKeyScope('accounting:read') @Get('accounting-export')
  async accounting(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const out = await this.reports.accountingCsvForKey(req.apiKey.storeId, q, req.apiKey);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out.csv);
  }
}
