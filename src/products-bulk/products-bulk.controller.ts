/* eslint-disable prettier/prettier */
import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { ProductsBulkService } from './products-bulk.service';
import { BulkEditDto, BulkStatusDto, BulkTagsDto, BulkTargetDto } from './dto/bulk-products.dto';

const role = (req: any): 'seller' | 'staff' => (req.user.role === 'staff' ? 'staff' : 'seller');

/** Bulk product actions (Shopify product list: Set as active/draft, Archive, Delete, Add/Remove tags, "Edit products").
 *  Every route carries `:storeId`, so PermissionsGuard pins a staff caller to their own store. */
@ApiTags('Products bulk')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/products-bulk')
export class ProductsBulkController {
  constructor(private readonly bulk: ProductsBulkService) {}

  @RequirePermission('products.edit')
  @Post(':storeId/status')
  setStatus(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkStatusDto) {
    return this.bulk.setStatus(actingSellerId(req.user), storeId, role(req), dto, dto.status);
  }

  @RequirePermission('products.edit')
  @Post(':storeId/tags')
  updateTags(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkTagsDto) {
    return this.bulk.updateTags(actingSellerId(req.user), storeId, role(req), dto);
  }

  @RequirePermission('products.delete')
  @Post(':storeId/delete')
  deleteProducts(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkTargetDto) {
    return this.bulk.deleteProducts(actingSellerId(req.user), storeId, role(req), dto);
  }

  @RequirePermission('products.edit')
  @Post(':storeId/edit')
  editProducts(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkEditDto) {
    const perms: string[] = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    const canEditPrice = req.user.role !== 'staff' || perms.includes('products.edit_price');
    return this.bulk.editProducts(actingSellerId(req.user), storeId, role(req), dto, canEditPrice);
  }
}
