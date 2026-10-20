/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { OrderDocumentsService } from './order-documents.service';
import { UpdateOrderDocumentSettingsDto } from './dto/update-order-document-settings.dto';

@ApiTags('Order documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@Controller('api/order-documents')
export class OrderDocumentsController {
  constructor(private readonly service: OrderDocumentsService) {}

  /** Anyone who may view orders can print them, so reading the settings needs only that. */
  @Get(':storeId')
  @RequirePermission('orders.view', 'settings.general.manage')
  get(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.get(actingSellerId(req.user), storeId);
  }

  @Patch(':storeId')
  @RequirePermission('settings.general.manage')
  update(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateOrderDocumentSettingsDto) {
    return this.service.update(actingSellerId(req.user), storeId, dto);
  }
}
