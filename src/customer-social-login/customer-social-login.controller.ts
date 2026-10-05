/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { CustomerSocialLoginService, SOCIAL_PROVIDER_KEYS, SocialProviderKey } from './customer-social-login.service';

function asProvider(value: string): SocialProviderKey {
  if (!SOCIAL_PROVIDER_KEYS.includes(value as SocialProviderKey)) throw new BadRequestException(`Unknown provider "${value}"`);
  return value as SocialProviderKey;
}

/** Seller/staff side: Settings → Customer accounts → Authentication. Staff are pinned to their own store by PermissionsGuard. */
@ApiTags('Customer social login (store settings)')
@ApiBearerAuth('accessToken')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.general.manage')
@Controller('api/store/:storeId/customer-login')
export class SellerCustomerSocialLoginController {
  constructor(private readonly service: CustomerSocialLoginService) {}

  @Get()
  get(@Param('storeId') storeId: string, @Req() req: any) {
    return this.service.getSetup(storeId, actingSellerId(req.user));
  }

  @Put(':provider')
  connect(@Param('storeId') storeId: string, @Param('provider') provider: string, @Body() body: { clientId?: string; clientSecret?: string }, @Req() req: any) {
    return this.service.connect(storeId, actingSellerId(req.user), asProvider(provider), body ?? {});
  }

  @Delete(':provider')
  disconnect(@Param('storeId') storeId: string, @Param('provider') provider: string, @Req() req: any) {
    return this.service.disconnect(storeId, actingSellerId(req.user), asProvider(provider));
  }
}

/** Public side used by a store's login/register pages and by the provider's redirect back. */
@ApiTags('Customer social login (storefront)')
@Controller('api/auth/social')
export class BuyerSocialLoginController {
  constructor(private readonly service: CustomerSocialLoginService) {}

  @Get('providers')
  async providers(@Query('storeId') storeId: string) {
    return { success: true, data: { providers: await this.service.connectedProviders(typeof storeId === 'string' ? storeId : '') } };
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('start/:provider')
  async start(@Param('provider') provider: string, @Query('storeId') storeId: string, @Query('returnTo') returnTo: string, @Res() res: Response) {
    const url = await this.service.buildAuthUrl(String(storeId ?? ''), asProvider(provider), String(returnTo ?? ''));
    res.redirect(302, url);
  }

  @Get('callback/:provider/:storeId')
  async callback(
    @Param('provider') provider: string,
    @Param('storeId') storeId: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const out = await this.service.handleCallback(asProvider(provider), storeId, code, state, error);
    if (out.redirectTo) return res.redirect(302, out.redirectTo);
    return res.status(400).type('text/plain').send(out.error ?? 'Sign-in failed');
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('exchange')
  exchange(@Body() body: { code?: string }) {
    return this.service.exchange(String(body?.code ?? ''));
  }
}
