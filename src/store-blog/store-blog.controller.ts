/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreBlogService } from './store-blog.service';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';
import { UpdateBlogContentDto } from './dto/update-blog-content.dto';
import { CreateBlogDto } from './dto/create-blog.dto';
import { UpdateBlogDto } from './dto/update-blog.dto';

@ApiTags('Store Blog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store-blog')
export class StoreBlogController {
  constructor(private readonly storeBlogService: StoreBlogService) {}

  // ── Blogs (the "multiple blogs" container) — static segments, must be
  // declared before the `:postId`/`:commentId`-shaped dynamic routes below
  // so they aren't swallowed as an id. ───────────────────────────────────

  @Get(':storeId/blogs')
  listBlogs(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeBlogService.listBlogs(storeId, req.user.userId);
  }

  @Post(':storeId/blogs')
  createBlog(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateBlogDto) {
    return this.storeBlogService.createBlog(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/blogs/:blogId')
  updateBlog(@Req() req: any, @Param('storeId') storeId: string, @Param('blogId') blogId: string, @Body() dto: UpdateBlogDto) {
    return this.storeBlogService.updateBlog(storeId, req.user.userId, blogId, dto);
  }

  @Delete(':storeId/blogs/:blogId')
  removeBlog(@Req() req: any, @Param('storeId') storeId: string, @Param('blogId') blogId: string) {
    return this.storeBlogService.deleteBlog(storeId, req.user.userId, blogId);
  }

  // ── Comments — same static-before-dynamic ordering requirement. ─────────

  @Get(':storeId/comments')
  listComments(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string) {
    return this.storeBlogService.listCommentsForSeller(storeId, req.user.userId, status);
  }

  @Patch(':storeId/comments/:commentId')
  moderateComment(@Req() req: any, @Param('storeId') storeId: string, @Param('commentId') commentId: string, @Body() body: { status: 'approved' | 'spam' | 'pending' }) {
    return this.storeBlogService.moderateComment(storeId, req.user.userId, commentId, body.status);
  }

  @Delete(':storeId/comments/:commentId')
  removeComment(@Req() req: any, @Param('storeId') storeId: string, @Param('commentId') commentId: string) {
    return this.storeBlogService.deleteComment(storeId, req.user.userId, commentId);
  }

  // ── Posts ─────────────────────────────────────────────────────────────

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string, @Query('blogId') blogId?: string) {
    return this.storeBlogService.listForSeller(storeId, req.user.userId, blogId);
  }

  @Get(':storeId/:postId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.getForSeller(storeId, req.user.userId, postId);
  }

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateBlogPostDto) {
    return this.storeBlogService.createPost(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/:postId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string, @Body() dto: UpdateBlogPostDto) {
    return this.storeBlogService.updatePost(storeId, req.user.userId, postId, dto);
  }

  @Patch(':storeId/:postId/content')
  updateContent(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string, @Body() dto: UpdateBlogContentDto) {
    return this.storeBlogService.updateContent(storeId, req.user.userId, postId, dto);
  }

  @Patch(':storeId/:postId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string, @Body() body?: { scheduledAt?: string | null }) {
    return this.storeBlogService.publish(storeId, req.user.userId, postId, body?.scheduledAt);
  }

  @Patch(':storeId/:postId/unpublish')
  unpublish(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.unpublish(storeId, req.user.userId, postId);
  }

  @Delete(':storeId/:postId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.deletePost(storeId, req.user.userId, postId);
  }
}
