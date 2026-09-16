/* eslint-disable prettier/prettier */
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OptionalJwtAuthGuard } from '@/auth/guards/optional-jwt-auth.guard';
import { ProductViewsService } from './product-views.service';

/** Phase 5 — public, no-login-required product-view beacon. A buyer browsing
 *  anonymously must be trackable (most storefront traffic never logs in), so
 *  this is OptionalJwtAuthGuard rather than JwtAuthGuard: a JWT is used when
 *  present, but never required. Throttled per IP to stop it being spammed
 *  into fabricating view counts — the analytics built on this data in Phase 6
 *  are only as real as the traffic this endpoint honestly records. */
@Controller('api/product-views')
export class ProductViewsController {
  constructor(private readonly productViewsService: ProductViewsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  recordView(@Req() req: any, @Body('productId') productId: string, @Body('anonId') anonId: string) {
    return this.productViewsService.recordView(productId, {
      userId: req.user?.userId ?? null,
      anonId,
    });
  }
}
