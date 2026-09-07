import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { StoreBlogService } from './store-blog.service';
import { SubmitCommentDto } from './dto/submit-comment.dto';

// Public — no auth. Backs `/:slug/blog[s/:blogSlug]` and `/:slug/blog/:postSlug`.
@ApiTags('Store Blog (public)')
@Controller('api/public/store-blog')
export class PublicStoreBlogController {
  constructor(private readonly storeBlogService: StoreBlogService) {}

  @Get(':storeId')
  list(@Param('storeId') storeId: string, @Query('blog') blogSlug?: string, @Query('page') pageQuery?: string, @Query('limit') limitQuery?: string) {
    const page = Math.max(1, parseInt(pageQuery as string) || 1);
    const limit = Math.min(30, Math.max(1, parseInt(limitQuery as string) || 10));
    return this.storeBlogService.listPublic(storeId, blogSlug, page, limit);
  }

  // Takes the post's real id (from `getBySlug`'s response), not its slug —
  // same convention as `submitComment` right below.
  @Get(':storeId/:postId/comments')
  listComments(@Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.listPublicComments(postId);
  }

  @Post(':storeId/:postId/comments')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  submitComment(@Param('storeId') storeId: string, @Param('postId') postId: string, @Body() dto: SubmitCommentDto) {
    return this.storeBlogService.submitComment(storeId, postId, dto);
  }

  @Get(':storeId/:slug')
  getBySlug(@Param('storeId') storeId: string, @Param('slug') slug: string) {
    return this.storeBlogService.getPublicBySlug(storeId, slug);
  }
}
