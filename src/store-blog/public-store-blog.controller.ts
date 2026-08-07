import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StoreBlogService } from './store-blog.service';

// Public — no auth. Backs `/:slug/blog` and `/:slug/blog/:postSlug`.
@ApiTags('Store Blog (public)')
@Controller('api/public/store-blog')
export class PublicStoreBlogController {
  constructor(private readonly storeBlogService: StoreBlogService) {}

  @Get(':storeId')
  list(@Param('storeId') storeId: string, @Query('page') pageQuery?: string, @Query('limit') limitQuery?: string) {
    const page = Math.max(1, parseInt(pageQuery as string) || 1);
    const limit = Math.min(30, Math.max(1, parseInt(limitQuery as string) || 10));
    return this.storeBlogService.listPublic(storeId, page, limit);
  }

  @Get(':storeId/:slug')
  getBySlug(@Param('storeId') storeId: string, @Param('slug') slug: string) {
    return this.storeBlogService.getPublicBySlug(storeId, slug);
  }
}
