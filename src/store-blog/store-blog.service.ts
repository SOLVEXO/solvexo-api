/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlockSettings } from '../common/store-content/section-settings.validator';
import { slugify } from '../common/slug.util';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';
import { UpdateBlogContentDto } from './dto/update-blog-content.dto';
import { CreateBlogDto } from './dto/create-blog.dto';
import { UpdateBlogDto } from './dto/update-blog.dto';
import { SubmitCommentDto } from './dto/submit-comment.dto';

const CONTENT_BLOCK_TYPES = ['paragraph', 'heading', 'image', 'quote', 'list', 'divider'];
const MAX_CONTENT_BLOCKS = 60;

function validateContent(content: { type: string; settings: Record<string, any> }[]) {
  if (content.length > MAX_CONTENT_BLOCKS) throw new BadRequestException(`A post cannot have more than ${MAX_CONTENT_BLOCKS} content blocks`);
  for (const block of content) {
    if (!CONTENT_BLOCK_TYPES.includes(block.type)) throw new BadRequestException(`Block type "${block.type}" is not allowed in post content`);
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

@Injectable()
export class StoreBlogService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get blogPostModel() {
    return this.databaseService.repositories.blogPostModel;
  }
  private get blogModel() {
    return this.databaseService.repositories.blogModel;
  }
  private get blogCommentModel() {
    return this.databaseService.repositories.blogCommentModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  private async findOwnedPost(storeId: string, sellerId: string, postId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const post = await this.blogPostModel.findOne({ _id: postId, storeId, isDelete: false });
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  private async generateBlogSlug(storeId: string, name: string, excludeId?: string): Promise<string> {
    const base = slugify(name) || 'blog';
    let slug = base;
    let n = 1;
    while (
      await this.blogModel.findOne({ storeId, slug, isDelete: false, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
    ) {
      slug = `${base}-${n}`;
      n++;
    }
    return slug;
  }

  /** Every store implicitly has one blog even if it never explicitly
   *  creates one — lazily created + persisted on first need (same "lazy but
   *  persisted" convention as the Category/Campaign slug backfills), so the
   *  pre-existing single-blog storefront route (`/blog`) keeps working
   *  unchanged for a store that never touches the multi-blog feature. */
  async ensureDefaultBlog(storeId: string) {
    let blog = await this.blogModel.findOne({ storeId, isDelete: false }).sort({ createdAt: 1 });
    if (!blog) {
      blog = await this.blogModel.create({ storeId, title: 'Blog', slug: 'blog' });
    }
    return blog;
  }

  // ── Blogs (the "multiple blogs" container) ──────────────────────────────

  async listBlogs(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultBlog(storeId);
    const blogs = await this.blogModel.find({ storeId, isDelete: false }).sort({ createdAt: 1 }).lean();
    return { success: true, data: blogs };
  }

  async createBlog(storeId: string, sellerId: string, dto: CreateBlogDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const slug = await this.generateBlogSlug(storeId, dto.title);
    const blog = await this.blogModel.create({ storeId, title: dto.title, slug, commentsEnabled: dto.commentsEnabled ?? false });
    return { success: true, message: 'Blog created', data: blog };
  }

  async updateBlog(storeId: string, sellerId: string, blogId: string, dto: UpdateBlogDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const blog = await this.blogModel.findOne({ _id: blogId, storeId, isDelete: false });
    if (!blog) throw new NotFoundException('Blog not found');
    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) { set.title = dto.title; set.slug = await this.generateBlogSlug(storeId, dto.title, blogId); }
    if (dto.commentsEnabled !== undefined) set.commentsEnabled = dto.commentsEnabled;
    const updated = await this.blogModel.findByIdAndUpdate(blogId, { $set: set }, { new: true });
    return { success: true, message: 'Blog updated', data: updated };
  }

  async deleteBlog(storeId: string, sellerId: string, blogId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const blog = await this.blogModel.findOne({ _id: blogId, storeId, isDelete: false });
    if (!blog) throw new NotFoundException('Blog not found');
    const postCount = await this.blogPostModel.countDocuments({ blogId, isDelete: false });
    if (postCount > 0) throw new BadRequestException('Move or delete every article in this blog before deleting it.');
    await this.blogModel.findByIdAndUpdate(blogId, { $set: { isDelete: true } });
    return { success: true, message: 'Blog deleted' };
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  async listForSeller(storeId: string, sellerId: string, blogId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const filter: Record<string, unknown> = { storeId, isDelete: false };
    if (blogId) filter.blogId = blogId;
    const posts = await this.blogPostModel.find(filter).sort({ createdAt: -1 }).lean();
    return { success: true, data: posts };
  }

  async getForSeller(storeId: string, sellerId: string, postId: string) {
    const post = await this.findOwnedPost(storeId, sellerId, postId);
    return { success: true, data: post };
  }

  async createPost(storeId: string, sellerId: string, dto: CreateBlogPostDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const existing = await this.blogPostModel.findOne({ storeId, slug: dto.slug, isDelete: false });
    if (existing) throw new ConflictException(`A post with slug "${dto.slug}" already exists`);

    let blogId = dto.blogId;
    if (blogId) {
      const blog = await this.blogModel.findOne({ _id: blogId, storeId, isDelete: false });
      if (!blog) throw new NotFoundException('Blog not found');
    } else {
      blogId = (await this.ensureDefaultBlog(storeId))._id.toString();
    }

    const post = await this.blogPostModel.create({
      storeId, blogId, title: dto.title, slug: dto.slug, excerpt: dto.excerpt ?? '', coverImage: dto.coverImage ?? null,
      content: [], status: 'draft',
    });
    return { success: true, message: 'Post created', data: post };
  }

  async updatePost(storeId: string, sellerId: string, postId: string, dto: UpdateBlogPostDto) {
    const post = await this.findOwnedPost(storeId, sellerId, postId);
    if (dto.slug !== undefined && dto.slug !== post.slug) {
      const conflict = await this.blogPostModel.findOne({ storeId, slug: dto.slug, isDelete: false, _id: { $ne: postId } });
      if (conflict) throw new ConflictException(`A post with slug "${dto.slug}" already exists`);
    }

    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.slug !== undefined) set.slug = dto.slug;
    if (dto.excerpt !== undefined) set.excerpt = dto.excerpt;
    if (dto.coverImage !== undefined) set.coverImage = dto.coverImage;
    if (dto.tags !== undefined) set.tags = dto.tags;

    const updated = await this.blogPostModel.findByIdAndUpdate(postId, { $set: set }, { new: true });
    return { success: true, message: 'Post updated', data: updated };
  }

  async updateContent(storeId: string, sellerId: string, postId: string, dto: UpdateBlogContentDto) {
    await this.findOwnedPost(storeId, sellerId, postId);
    validateContent(dto.content);
    const updated = await this.blogPostModel.findByIdAndUpdate(postId, { $set: { content: dto.content } }, { new: true });
    return { success: true, message: 'Content updated', data: updated };
  }

  /** `scheduledAt` in the future -> 'scheduled' (goes live automatically via
   *  SchedulerService#publishScheduledBlogPosts, a minute-tick cron); omitted
   *  or in the past -> published immediately, same as before. */
  async publish(storeId: string, sellerId: string, postId: string, scheduledAt?: string | null) {
    const post = await this.findOwnedPost(storeId, sellerId, postId);
    const future = scheduledAt ? new Date(scheduledAt) : null;
    const updated = future && future.getTime() > Date.now()
      ? await this.blogPostModel.findByIdAndUpdate(postId, { $set: { status: 'scheduled', scheduledAt: future, publishedAt: null } }, { new: true })
      : await this.blogPostModel.findByIdAndUpdate(postId, { $set: { status: 'published', publishedAt: post.publishedAt ?? new Date(), scheduledAt: null } }, { new: true });
    return { success: true, message: future && future.getTime() > Date.now() ? 'Post scheduled' : 'Post published', data: updated };
  }

  async unpublish(storeId: string, sellerId: string, postId: string) {
    await this.findOwnedPost(storeId, sellerId, postId);
    const updated = await this.blogPostModel.findByIdAndUpdate(postId, { $set: { status: 'draft', scheduledAt: null } }, { new: true });
    return { success: true, message: 'Post unpublished', data: updated };
  }

  async deletePost(storeId: string, sellerId: string, postId: string) {
    await this.findOwnedPost(storeId, sellerId, postId);
    await this.blogPostModel.findByIdAndUpdate(postId, { $set: { isDelete: true } });
    return { success: true, message: 'Post deleted' };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  /** `blogSlug` omitted = the store's default blog (preserves the exact
   *  pre-multi-blog `/blog` behavior); pass it to list a specific named
   *  blog's posts instead (storefront route `/blogs/:blogSlug`). */
  async listPublic(storeId: string, blogSlug?: string, page = 1, limit = 10) {
    const blog = blogSlug
      ? await this.blogModel.findOne({ storeId, slug: blogSlug, isDelete: false }).lean()
      : await this.ensureDefaultBlog(storeId);
    if (!blog) throw new NotFoundException('Blog not found');

    const skip = (page - 1) * limit;
    const filter = { storeId, blogId: blog._id.toString(), status: 'published', isDelete: false };
    const [posts, total] = await Promise.all([
      this.blogPostModel.find(filter)
        .sort({ publishedAt: -1 }).skip(skip).limit(limit)
        .select('title slug coverImage excerpt tags publishedAt').lean(),
      this.blogPostModel.countDocuments(filter),
    ]);
    return { success: true, data: { blog: { title: blog.title, slug: blog.slug }, posts, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } } };
  }

  async getPublicBySlug(storeId: string, slug: string) {
    const post = await this.blogPostModel.findOne({ storeId, slug, status: 'published', isDelete: false }).lean();
    if (!post) throw new NotFoundException('Post not found');
    const blog = post.blogId ? await this.blogModel.findById(post.blogId).select('commentsEnabled title slug').lean() : null;
    return { success: true, data: { ...post, commentsEnabled: blog?.commentsEnabled ?? false } };
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  async submitComment(storeId: string, postId: string, dto: SubmitCommentDto) {
    const post = await this.blogPostModel.findOne({ _id: postId, storeId, status: 'published', isDelete: false }).lean();
    if (!post) throw new NotFoundException('Post not found');
    const blog = post.blogId ? await this.blogModel.findById(post.blogId).select('commentsEnabled').lean() : null;
    if (!blog?.commentsEnabled) throw new BadRequestException('Comments are not enabled on this blog.');

    const comment = await this.blogCommentModel.create({
      storeId, blogPostId: postId, authorName: dto.authorName, authorEmail: dto.authorEmail, body: dto.body, status: 'pending',
    });
    return { success: true, message: 'Your comment has been submitted and will appear once approved.', data: comment };
  }

  async listPublicComments(postId: string) {
    const comments = await this.blogCommentModel.find({ blogPostId: postId, status: 'approved' }).sort({ createdAt: -1 }).select('authorName body createdAt').lean();
    return { success: true, data: comments };
  }

  async listCommentsForSeller(storeId: string, sellerId: string, status?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const filter: Record<string, unknown> = { storeId };
    if (status) filter.status = status;
    const comments = await this.blogCommentModel.find(filter).sort({ createdAt: -1 }).lean();
    return { success: true, data: comments };
  }

  async moderateComment(storeId: string, sellerId: string, commentId: string, status: 'approved' | 'spam' | 'pending') {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const comment = await this.blogCommentModel.findOneAndUpdate({ _id: commentId, storeId }, { $set: { status } }, { new: true });
    if (!comment) throw new NotFoundException('Comment not found');
    return { success: true, data: comment };
  }

  async deleteComment(storeId: string, sellerId: string, commentId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const result = await this.blogCommentModel.deleteOne({ _id: commentId, storeId });
    if (result.deletedCount === 0) throw new NotFoundException('Comment not found');
    return { success: true, message: 'Comment deleted' };
  }
}
