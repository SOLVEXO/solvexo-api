import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ShippingCarriersService } from './shipping-carriers.service';
import { CreateShippingCarrierDto, UpdateShippingCarrierDto } from './dto/shipping-carrier.dto';

@ApiTags('Store Shipping Carriers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/shipping-carriers/:storeId')
export class ShippingCarriersController {
  constructor(private readonly shippingCarriersService: ShippingCarriersService) {}

  @Get()
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.shippingCarriersService.list(storeId, req.user.userId);
  }

  @Post()
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateShippingCarrierDto) {
    return this.shippingCarriersService.create(storeId, req.user.userId, dto);
  }

  @Patch(':carrierId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('carrierId') carrierId: string, @Body() dto: UpdateShippingCarrierDto) {
    return this.shippingCarriersService.update(storeId, req.user.userId, carrierId, dto);
  }

  @Delete(':carrierId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('carrierId') carrierId: string) {
    return this.shippingCarriersService.remove(storeId, req.user.userId, carrierId);
  }
}
