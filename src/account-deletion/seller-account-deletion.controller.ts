/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SellerAccountDeletionService } from './seller-account-deletion.service';

class RequestDeletionDto {
  @IsOptional() @IsString() password?: string;
}

/** Owner-only (the owner's own JWT — never a POS device token). */
@ApiTags('Account deletion')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/seller/account-deletion')
export class SellerAccountDeletionController {
  constructor(private readonly service: SellerAccountDeletionService) {}

  @Get()
  status(@Req() req: any) { return this.service.status(req.user.userId); }

  @Post()
  request(@Req() req: any, @Body() dto: RequestDeletionDto) { return this.service.request(req.user.userId, dto.password, req.ip); }

  @Post('cancel')
  cancel(@Req() req: any) { return this.service.cancel(req.user.userId); }
}
