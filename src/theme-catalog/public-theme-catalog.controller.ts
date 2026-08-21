/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThemeCatalogService } from './theme-catalog.service';
import { ListThemeQueryDto } from './dto/list-theme-query.dto';

// No auth guard — the Theme Library must be browsable (and demo-previewable,
// per the plan's "Demo Preview" requirement) by a logged-out visitor too,
// same as `public-store-theme.controller.ts`/`public-store-pages.controller.ts`.
@ApiTags('Public Theme Catalog')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/public/theme-catalog')
export class PublicThemeCatalogController {
  constructor(private readonly themeCatalogService: ThemeCatalogService) {}

  @Get()
  list(@Query() query: ListThemeQueryDto) {
    return this.themeCatalogService.publicList(query);
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.themeCatalogService.publicGetBySlug(slug);
  }
}
