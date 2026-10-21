/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FillUiKeysDto } from './dto/fill-ui-keys.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { UiLocalesService } from './ui-locales.service';

@ApiTags('UI locales (public)')
@Controller('api/public/ui-locale')
export class PublicUiLocalesController {
  constructor(private readonly service: UiLocalesService) {}

  /** `{ status: 'ready', strings }` once the language's storefront text exists; `generating` / `unavailable` / `static` otherwise. */
  @Get(':locale')
  async get(@Param('locale') locale: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.service.get(locale);
    res.setHeader('Cache-Control', result.status === 'ready' ? 'public, max-age=3600, stale-while-revalidate=86400' : 'no-store');
    return { success: true, data: result };
  }
}

@ApiTags('UI locales (public fill)')
@Controller('api/public/ui-locale')
export class PublicUiLocaleFillController {
  constructor(private readonly service: UiLocalesService) {}

  /** Translations of storefront labels the visitor's bundle is missing (key -> text); only keys of the English bundle. */
  @Post(':locale/fill')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async fill(@Param('locale') locale: string, @Body() dto: FillUiKeysDto) {
    return { success: true, data: { strings: await this.service.fill(locale, dto.keys) } };
  }
}

@ApiTags('UI locales (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@Controller('api/admin/ui-locales')
export class AdminUiLocalesController {
  constructor(private readonly service: UiLocalesService) {}

  @Post(':locale/regenerate')
  @RequirePermission('config.manage')
  async regenerate(@Param('locale') locale: string) {
    return { success: true, data: await this.service.regenerate(locale) };
  }
}
