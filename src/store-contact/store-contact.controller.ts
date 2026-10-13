/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreContactService } from './store-contact.service';
import { CreateContactMessageDto, UpdateContactMessageDto } from './dto/create-contact-message.dto';

/** Seller inbox for the storefront contact form. Staff with `onlinestore.content.manage` can read and triage it too. */
@ApiTags('Store contact messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-contact')
export class StoreContactController {
  constructor(private readonly service: StoreContactService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string, @Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string) {
    return this.service.list(storeId, actingSellerId(req.user), { page: Number(page), limit: Number(limit), status });
  }

  @Patch(':storeId/:id')
  setStatus(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateContactMessageDto) {
    return this.service.setStatus(storeId, actingSellerId(req.user), id, dto.status);
  }

  @Delete(':storeId/:id')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.service.remove(storeId, actingSellerId(req.user), id);
  }
}

/** Public (no login): a visitor sends a message to the store. Strictly rate limited. */
@ApiTags('Store contact (public)')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/public/store-contact')
export class PublicStoreContactController {
  constructor(private readonly service: StoreContactService) {}

  @Post(':storeId')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  submit(@Param('storeId') storeId: string, @Body() dto: CreateContactMessageDto) {
    return this.service.submit(storeId, dto);
  }
}
