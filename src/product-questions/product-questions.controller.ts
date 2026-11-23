/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { ProductQuestionsService } from './product-questions.service';

/** Seller inbox for shopper questions on product pages. */
@ApiTags('Product questions (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/product-questions/:storeId')
export class ProductQuestionsController {
  constructor(private readonly svc: ProductQuestionsService, private readonly db: DatabaseService) {}
  private own(req: any, s: string) { return verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, s, actingSellerId(req.user)); }

  @Get() @RequirePermission('products.view') async list(@Req() r: any, @Param('storeId') s: string, @Query() q: any) { await this.own(r, s); return this.svc.sellerList(s, q); }
  @Put(':id/answer') @RequirePermission('products.edit') async answer(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { await this.own(r, s); return this.svc.answer(s, id, b); }
  @Put(':id/status') @RequirePermission('products.edit') async status(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { await this.own(r, s); return this.svc.setStatus(s, id, b?.status); }
  @Delete(':id') @RequirePermission('products.edit') async remove(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(r, s); return this.svc.remove(s, id); }
}

@ApiTags('Product questions (public)')
@Controller('api/public/product-questions/:storeId/:productId')
export class PublicProductQuestionsController {
  constructor(private readonly svc: ProductQuestionsService) {}
  @Get() @Throttle({ default: { limit: 120, ttl: 60_000 } }) list(@Param('storeId') s: string, @Param('productId') p: string) { return this.svc.publicList(s, p); }
  @Post() @Throttle({ default: { limit: 5, ttl: 60_000 } }) ask(@Param('storeId') s: string, @Param('productId') p: string, @Body() b: any) { return this.svc.ask(s, p, b); }
}
