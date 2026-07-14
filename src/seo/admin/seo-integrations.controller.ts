/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Delete, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { SeoIntegrationsService } from '../services/seo-integrations.service';
import { ConnectIntegrationDto, GetAuthUrlDto, assertValidProvider } from '../dto/connect-integration.dto';

@ApiTags('Admin SEO — Search Integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/seo/integrations')
export class AdminSeoIntegrationsController {
  constructor(private readonly integrations: SeoIntegrationsService) {}

  @Get()
  list() {
    return this.integrations.list({ scope: 'platform', storeId: null });
  }

  @Get(':provider/authorize-url')
  getAuthUrl(@Param('provider') provider: string, @Query() query: GetAuthUrlDto) {
    assertValidProvider(provider);
    return { url: this.integrations.getAuthorizationUrl(provider, query.redirectUri, 'platform') };
  }

  @Post(':provider/connect')
  connect(@Req() req: any, @Param('provider') provider: string, @Body() dto: ConnectIntegrationDto) {
    assertValidProvider(provider);
    return this.integrations.connect(
      { scope: 'platform', storeId: null },
      provider,
      dto.code,
      dto.redirectUri,
      dto.siteIdentifier,
      { id: req.user.userId, role: req.user.role },
    );
  }

  @Delete(':provider')
  disconnect(@Req() req: any, @Param('provider') provider: string) {
    assertValidProvider(provider);
    return this.integrations.disconnect({ scope: 'platform', storeId: null }, provider, { id: req.user.userId, role: req.user.role });
  }

  @Post(':provider/sync')
  sync(@Param('provider') provider: string, @Query('days') days?: string) {
    assertValidProvider(provider);
    const to = new Date();
    const from = new Date(to.getTime() - Number(days ?? 28) * 24 * 60 * 60 * 1000);
    return this.integrations.sync({ scope: 'platform', storeId: null }, provider, from, to);
  }
}
