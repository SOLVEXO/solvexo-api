/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { StoreBlogService } from './store-blog.service';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';
import { UpdateBlogContentDto } from './dto/update-blog-content.dto';

@ApiTags('Store Blog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store-blog')
export class StoreBlogController {
  constructor(private readonly storeBlogService: StoreBlogService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeBlogService.listForSeller(storeId, req.user.userId);
  }

  @Get(':storeId/:postId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.getForSeller(storeId, req.user.userId, postId);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storefrontBlog')
  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateBlogPostDto) {
    return this.storeBlogService.createPost(storeId, req.user.userId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storefrontBlog')
  @Patch(':storeId/:postId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string, @Body() dto: UpdateBlogPostDto) {
    return this.storeBlogService.updatePost(storeId, req.user.userId, postId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storefrontBlog')
  @Patch(':storeId/:postId/content')
  updateContent(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string, @Body() dto: UpdateBlogContentDto) {
    return this.storeBlogService.updateContent(storeId, req.user.userId, postId, dto);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storefrontBlog')
  @Patch(':storeId/:postId/publish')
  publish(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.publish(storeId, req.user.userId, postId);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storefrontBlog')
  @Patch(':storeId/:postId/unpublish')
  unpublish(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.unpublish(storeId, req.user.userId, postId);
  }

  @UseGuards(FeatureFlagGuard)
  @RequireFeature('storefrontBlog')
  @Delete(':storeId/:postId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('postId') postId: string) {
    return this.storeBlogService.deletePost(storeId, req.user.userId, postId);
  }
}
