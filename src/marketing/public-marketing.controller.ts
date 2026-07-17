/* eslint-disable prettier/prettier */
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MarketingService } from './marketing.service';

// Public — no auth guard. Buyers browsing the marketplace/homepage need to
// see active platform-wide sale campaigns without logging in.
// Deliberately NOT under 'api/marketing/:storeId/...' — that dynamic prefix
// would greedily swallow a literal 'public' segment as :storeId.
@ApiTags('Marketing (public)')
@Controller('api/public/marketing')
export class PublicMarketingController {
  constructor(private readonly marketingService: MarketingService) {}

  @Get('campaigns')
  getActiveCampaigns() {
    return this.marketingService.getPublicActiveCampaigns();
  }
}
