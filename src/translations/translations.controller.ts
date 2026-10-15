import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { StoreAccessGuard } from '../common/guards/store-access.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SaveTranslationDto } from './dto/translation.dto';
import { isTranslationResource, TranslationResource, TranslationsService } from './translations.service';

/** Which staff permission edits which kind of content (a seller always passes). */
const RESOURCE_PERMISSION: Record<TranslationResource, string> = {
  products: 'products.edit',
  collections: 'collections.manage',
  pages: 'onlinestore.content.manage',
  menus: 'onlinestore.content.manage',
};

function resourceFrom(user: any, raw: string): TranslationResource {
  if (!isTranslationResource(raw)) throw new BadRequestException('Unknown resource');
  if (user?.role === 'staff') {
    const granted: string[] = Array.isArray(user.permissions) ? user.permissions : [];
    if (!granted.includes(RESOURCE_PERMISSION[raw])) throw new ForbiddenException(`Your role can't translate ${raw}`);
  }
  return raw;
}

@ApiTags('Translations')
@ApiBearerAuth()
@Controller('api/translations')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, StoreAccessGuard)
@Roles('seller', 'staff')
@RequirePermission('products.edit', 'collections.manage', 'onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class TranslationsController {
  constructor(private readonly service: TranslationsService) {}

  @Get(':storeId/:resource')
  async list(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('resource') resource: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ) {
    const res = resourceFrom(req.user, resource);
    return { success: true, data: await this.service.list(storeId, res, { page, limit, q }) };
  }

  @Put(':storeId/:resource/:id/:locale')
  async save(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Param('locale') locale: string,
    @Body() dto: SaveTranslationDto,
  ) {
    const res = resourceFrom(req.user, resource);
    return { success: true, data: await this.service.save(storeId, res, id, locale, dto) };
  }

  @Delete(':storeId/:resource/:id/:locale')
  @HttpCode(200)
  async remove(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Param('locale') locale: string,
  ) {
    const res = resourceFrom(req.user, resource);
    await this.service.remove(storeId, res, id, locale);
    return { success: true };
  }
}
