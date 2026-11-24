/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DevelopmentStoresService } from './development-stores.service';

/** Developers' free test stores (any seller account; only the seller's own login, like developer apps). */
@ApiTags('Development stores (developer)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/developer/stores')
export class DeveloperStoresController {
  constructor(private readonly svc: DevelopmentStoresService) {}
  private me(req: any) { return String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''); }
  @Get() list(@Req() req: any) { return this.svc.list(this.me(req)); }
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post() create(@Req() req: any, @Body() b: any) { return this.svc.create(this.me(req), b); }
  @Delete(':id') remove(@Req() req: any, @Param('id') id: string) { return this.svc.remove(this.me(req), id); }
}
