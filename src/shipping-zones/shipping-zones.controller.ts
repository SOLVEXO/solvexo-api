/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ShippingZonesService } from './shipping-zones.service';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';
import { UpdateShippingZoneDto } from './dto/update-shipping-zone.dto';

@ApiTags('Admin Shipping Zones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/shipping-zones')
export class ShippingZonesController {
  constructor(private readonly shippingZonesService: ShippingZonesService) {}

  @Get()
  list(@Query() query: { status?: string; country?: string }) {
    return this.shippingZonesService.list(query);
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateShippingZoneDto) {
    return this.shippingZonesService.create(req.user.userId, dto);
  }

  @Patch(':zoneId')
  update(@Req() req: any, @Param('zoneId') zoneId: string, @Body() dto: UpdateShippingZoneDto) {
    return this.shippingZonesService.update(req.user.userId, zoneId, dto);
  }

  @Delete(':zoneId')
  remove(@Req() req: any, @Param('zoneId') zoneId: string) {
    return this.shippingZonesService.remove(req.user.userId, zoneId);
  }
}
