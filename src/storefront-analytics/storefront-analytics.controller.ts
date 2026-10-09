/* eslint-disable prettier/prettier */
import { Body, Controller, HttpCode, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { OptionalJwtAuthGuard } from '@/auth/guards/optional-jwt-auth.guard';
import { StorefrontAnalyticsService } from './storefront-analytics.service';

const ID = /^[A-Za-z0-9_-]{8,64}$/;

export class StorefrontPageViewDto {
  @IsMongoId() storeId: string;
  @Matches(ID) sessionId: string;
  @Matches(ID) visitorId: string;
  @IsOptional() @IsString() @MaxLength(500) path?: string;
  @IsOptional() @IsString() @MaxLength(500) referrer?: string;
  @IsOptional() @IsString() @MaxLength(100) utmSource?: string;
  @IsOptional() @IsString() @MaxLength(100) utmMedium?: string;
  @IsOptional() @IsString() @MaxLength(100) utmCampaign?: string;
  @IsOptional() @IsString() @MaxLength(64) timeZone?: string;
}

/**
 * Public storefront beacon (one call per page view). No login needed; a buyer's JWT, when present, links the
 * visit to the customer. Never returns data, so it can't be used to read another store's analytics.
 */
@Controller('api/storefront-analytics')
export class StorefrontAnalyticsController {
  constructor(private readonly service: StorefrontAnalyticsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }))
  @HttpCode(202)
  @Post('page-view')
  async pageView(@Req() req: any, @Body() body: StorefrontPageViewDto) {
    const header = (name: string) => {
      const v = req.headers?.[name];
      return Array.isArray(v) ? v[0] : v;
    };
    await this.service.recordPageView(body, {
      userAgent: header('user-agent'),
      // CDN geo headers (Cloudflare / Vercel / CloudFront) when the API sits behind one.
      geoCountry: header('cf-ipcountry') ?? header('x-vercel-ip-country') ?? header('cloudfront-viewer-country'),
      userId: req.user?.role === 'user' ? req.user.userId : null,
    });
    return { ok: true };
  }
}
