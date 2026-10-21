/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Header, Param, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreTextTranslationsService } from './store-text-translations.service';
import { AutoTranslateTextDto, SaveTextTranslationsDto } from './dto/store-text-translations.dto';

@ApiTags('Store text translations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@Controller('api/store-text-translations')
export class StoreTextTranslationsController {
  constructor(private readonly service: StoreTextTranslationsService) {}

  /** Everything translatable, grouped by where it shows (store details, announcement, header, footer, pages, FAQs...). */
  @Get(':storeId/sources')
  async sources(@Req() req: any, @Param('storeId') storeId: string, @Query('scope') scope?: string) {
    return { success: true, data: await this.service.sources(actingSellerId(req.user), storeId, scope) };
  }

  @Get(':storeId/:locale')
  async list(@Req() req: any, @Param('storeId') storeId: string, @Param('locale') locale: string) {
    return { success: true, data: await this.service.list(actingSellerId(req.user), storeId, locale) };
  }

  @Put(':storeId/:locale')
  async save(@Req() req: any, @Param('storeId') storeId: string, @Param('locale') locale: string, @Body() dto: SaveTextTranslationsDto) {
    return { success: true, data: await this.service.save(actingSellerId(req.user), storeId, locale, dto.entries) };
  }

  @Post(':storeId/:locale/auto-translate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async autoTranslate(@Req() req: any, @Param('storeId') storeId: string, @Param('locale') locale: string, @Body() dto: AutoTranslateTextDto) {
    return { success: true, data: await this.service.autoTranslate(actingSellerId(req.user), storeId, locale, dto.keys) };
  }
}

@ApiTags('Store text translations (public)')
@Controller('api/public/store-text-translations')
export class PublicStoreTextTranslationsController {
  constructor(private readonly service: StoreTextTranslationsService) {}

  @Get(':storeId/:locale')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  async get(@Param('storeId') storeId: string, @Param('locale') locale: string) {
    return { success: true, data: { strings: await this.service.publicStrings(storeId, locale) } };
  }
}
