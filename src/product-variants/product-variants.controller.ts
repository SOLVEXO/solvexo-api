import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { canViewProductCost, omitCostPriceFromVariants } from '../common/product-cost-visibility.util';
import { ProductVariantsService } from './product-variants.service';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';

/** Tier-2 real split of the Products "price"/"cost"/"edit" fusion the Tier-1
 *  audit flagged as Partial (`price`/`compareAtPrice`/`costPrice` all share
 *  this one DTO). `@RequirePermission` can only gate a whole route, not
 *  individual body fields, so the field-level split is enforced here
 *  imperatively: `products.edit` is the baseline (structural fields), while
 *  touching a price field additionally requires `products.edit_price` and
 *  touching `costPrice` additionally requires `products.edit_cost` — a
 *  seller/admin caller is always exempt, same as every other permission
 *  check in this app. NOTE: this controller has no `:storeId` route param,
 *  so `PermissionsGuard`'s store-scope pin is a no-op here (a valid staff
 *  token is still scoped to the right SELLER via `actingSellerId`/the
 *  service's own product-ownership check — same disclosed shape as
 *  `stripe-connect.controller.ts`). */
function assertFieldPermission(user: any, body: Record<string, unknown>) {
  if (user.role !== 'staff') return; // seller/admin — always allowed
  const permissions: string[] = Array.isArray(user.permissions) ? user.permissions : [];
  if ((body.price !== undefined || body.compareAtPrice !== undefined) && !permissions.includes('products.edit_price')) {
    throw new ForbiddenException("Your staff account doesn't have permission to edit product prices.");
  }
  if (body.costPrice !== undefined && !permissions.includes('products.edit_cost')) {
    throw new ForbiddenException("Your staff account doesn't have permission to edit product cost prices.");
  }
}

@Controller('api/products')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
@RequirePermission('products.edit')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ProductVariantsController {
  constructor(
    private readonly productVariantsService: ProductVariantsService,
  ) {}

  @RequirePermission('products.view')
  @Get(':productId/variants')
  async listVariants(@Req() req: any, @Param('productId') productId: string) {
    const result: any = await this.productVariantsService.listVariants(actingSellerId(req.user), productId);
    if (!canViewProductCost(req.user)) {
      result.data = omitCostPriceFromVariants(result.data);
    }
    return result;
  }

  @Post(':productId/variants')
  async addVariant(
    @Req() req: any,
    @Param('productId') productId: string,
    @Body() body: CreateVariantDto,
  ) {
    // `price` is a required field on CreateVariantDto — creating a variant
    // always sets it, so this always needs `products.edit_price` for staff.
    assertFieldPermission(req.user, body as unknown as Record<string, unknown>);
    return this.productVariantsService.addVariant(actingSellerId(req.user), productId, body);
  }

  @Patch(':productId/variants/:variantId')
  async updateVariant(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() body: UpdateVariantDto,
  ) {
    assertFieldPermission(req.user, body as unknown as Record<string, unknown>);
    return this.productVariantsService.updateVariant(
      actingSellerId(req.user),
      productId,
      variantId,
      body,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Delete(':productId/variants/:variantId')
  async deleteVariant(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ) {
    return this.productVariantsService.deleteVariant(
      actingSellerId(req.user),
      productId,
      variantId,
    );
  }
}
