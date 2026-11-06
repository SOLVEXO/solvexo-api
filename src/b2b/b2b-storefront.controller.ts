/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { DatabaseService } from '../database/databaseservice';
import { B2BContextService } from './b2b-context.service';

const MAX_LINES = 50;
const MAX_QUICK_LINES = 100;

/** Storefront (buyer) side of B2B: apply for a wholesale account, see my standing, and ask the SERVER for my prices and rules. */
@ApiTags('B2B (storefront)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/b2b/storefront')
export class B2BStorefrontController {
  constructor(private readonly ctxSvc: B2BContextService, private readonly db: DatabaseService) {}

  @Get('me')
  me(@Req() req: any, @Query('storeId') storeId?: string) {
    return this.ctxSvc.me(resolveBuyerStoreScope(req.user.storeId, storeId), req.user.userId);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('apply')
  async apply(@Req() req: any, @Body() body: any) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, body?.storeId);
    const user: any = await (this.db.repositories.userModel as any).findOne({ _id: req.user.userId, storeId }).select('email contactEmail isGuest').lean();
    if (!user || user.isGuest) throw new BadRequestException('Sign in with a customer account to apply for wholesale.');
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('_id').lean();
    if (!store) throw new NotFoundException('Store not found');
    return this.ctxSvc.apply(storeId, { userId: String(req.user.userId), email: user.email ?? user.contactEmail }, body);
  }

  /**
   * Server-computed wholesale price, availability and quantity rule for up to 50 {variantId, quantity} lines. Themes call this to show
   * B2B prices; checkout recomputes the same numbers itself and never trusts what the browser sends back.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('prices')
  async prices(@Req() req: any, @Body() body: any) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, body?.storeId);
    const lines: any[] = Array.isArray(body?.lines) ? body.lines : [];
    if (lines.length === 0 || lines.length > MAX_LINES) throw new BadRequestException(`Send between 1 and ${MAX_LINES} lines`);
    const ids = lines.map((l) => String(l?.variantId ?? ''));
    if (ids.some((i) => !Types.ObjectId.isValid(i))) throw new BadRequestException('Invalid variant id');
    const ctx = await this.ctxSvc.getContext(storeId, String(req.user.userId));
    if (!ctx) return { b2b: false, lines: [] };

    const { productVariantModel, productModel } = this.db.repositories as any;
    const variants: any[] = await productVariantModel.find({ _id: { $in: ids }, isDelete: false }).select('_id productId price').lean();
    const products: any[] = await productModel.find({ _id: { $in: variants.map((v) => v.productId) }, storeId, isDelete: false, status: 'active' })
      .select('_id name orderMinQuantity orderMaxQuantity orderQuantityStep').lean();
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const entries = await this.ctxSvc.loadEntries(ctx, ids);
    const out = lines.map((l) => {
      const variantId = String(l.variantId);
      const variant = variants.find((v) => String(v._id) === variantId);
      const product = variant ? productById.get(String(variant.productId)) : null;
      if (!variant || !product) return { variantId, available: false, error: 'Not available' };
      const quantity = Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 1;
      try {
        const r = this.ctxSvc.resolveLine(ctx, entries, { productName: product.name, product, variantId, basePrice: variant.price, quantity });
        return { variantId, available: true, quantity, retailPrice: variant.price, unitPrice: r.unitPrice, rule: r.rule, priceBreaks: r.entry?.priceBreaks ?? [] };
      } catch (e: any) {
        const res = e?.getResponse?.();
        return { variantId, available: false, quantity, retailPrice: variant.price, error: typeof res === 'object' ? res.message : e?.message, suggested: typeof res === 'object' ? res.suggested : undefined };
      }
    });
    return { b2b: true, company: ctx.companyName, lines: out };
  }

  /**
   * Quick order list: up to 100 {sku, quantity} lines resolved on the server (this store only) with the buyer's wholesale price and
   * rules. Lines that cannot be bought come back with an error; the browser then adds the good ones to the cart.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('quick-order')
  async quickOrder(@Req() req: any, @Body() body: any) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, body?.storeId);
    const lines: any[] = Array.isArray(body?.lines) ? body.lines : [];
    if (lines.length === 0 || lines.length > MAX_QUICK_LINES) throw new BadRequestException(`Send between 1 and ${MAX_QUICK_LINES} lines`);
    const ctx = await this.ctxSvc.getContext(storeId, String(req.user.userId));
    if (!ctx) throw new BadRequestException('Quick order is for approved wholesale accounts.');
    const skus = [...new Set(lines.map((l) => (typeof l?.sku === 'string' ? l.sku.trim() : '')).filter(Boolean))].slice(0, MAX_QUICK_LINES);
    const { productVariantModel, productModel } = this.db.repositories as any;
    const candidates: any[] = await productVariantModel.find({ sku: { $in: skus }, isDelete: false }).select('_id productId sku price').lean();
    const products: any[] = await productModel.find({ _id: { $in: [...new Set(candidates.map((v) => v.productId))] }, storeId, isDelete: false, status: 'active' })
      .select('_id name type orderMinQuantity orderMaxQuantity orderQuantityStep').lean();
    const productById = new Map(products.map((p) => [String(p._id), p]));
    // The same SKU may exist in other stores: only variants of this store's active products count.
    const variants = candidates.filter((v) => productById.has(String(v.productId)));
    const bySku = new Map(variants.map((v) => [v.sku, v]));
    const entries = await this.ctxSvc.loadEntries(ctx, variants.map((v) => String(v._id)));
    const out = lines.map((l) => {
      const sku = typeof l?.sku === 'string' ? l.sku.trim() : '';
      const quantity = Number.isInteger(l?.quantity) && l.quantity > 0 ? l.quantity : 0;
      const variant = bySku.get(sku);
      const product = variant ? productById.get(String(variant.productId)) : null;
      if (!sku || !quantity) return { sku, quantity, ok: false, error: 'Enter a SKU and a whole quantity of 1 or more' };
      if (!variant || !product) return { sku, quantity, ok: false, error: 'SKU not found' };
      try {
        const r = this.ctxSvc.resolveLine(ctx, entries, { productName: product.name, product, variantId: String(variant._id), basePrice: variant.price, quantity });
        return { sku, quantity, ok: true, productId: String(product._id), variantId: String(variant._id), name: product.name, type: product.type, unitPrice: r.unitPrice };
      } catch (e: any) {
        const res = e?.getResponse?.();
        return { sku, quantity, ok: false, name: product.name, error: typeof res === 'object' ? res.message : e?.message, suggested: typeof res === 'object' ? res.suggested : undefined };
      }
    });
    return { lines: out };
  }
}
