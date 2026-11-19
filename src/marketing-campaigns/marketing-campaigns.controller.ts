/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { MarketingCampaignsService } from './marketing-campaigns.service';
import { CreateMarketingCampaignDto, UpdateMarketingCampaignDto } from './dto/marketing-campaign.dto';

@ApiTags('Marketing campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('marketing.manage')
@Controller('api/marketing-campaigns')
export class MarketingCampaignsController {
  constructor(private readonly service: MarketingCampaignsService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.list(actingSellerId(req.user), storeId);
  }

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateMarketingCampaignDto) {
    return this.service.create(actingSellerId(req.user), storeId, dto);
  }

  @Patch(':storeId/:id')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateMarketingCampaignDto) {
    return this.service.update(actingSellerId(req.user), storeId, id, dto);
  }

  @Delete(':storeId/:id')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.service.remove(actingSellerId(req.user), storeId, id);
  }
}
