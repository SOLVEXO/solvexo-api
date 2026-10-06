/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  parseListCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { slugify } from '../common/slug.util';

export const BLOG_POST_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Title', required: true, description: 'Article title (max 120 characters).', example: 'Our summer lookbook' },
  { key: 'Blog', description: 'Title or slug of an EXISTING blog in this store. Leave blank to use the default blog (no blog is created from the CSV).', example: '' },
  { key: 'Slug', description: 'Lowercase letters, numbers and hyphens (max 100). Auto-generated from the title when blank. Unique per store — an existing slug is skipped.', example: 'our-summer-lookbook' },
  { key: 'Body', description: 'Plain text. Blank lines separate paragraphs; HTML tags are stripped (the editor stores text blocks, not HTML). Images, headings and lists are added in the editor afterwards.', example: 'First paragraph.\n\nSecond paragraph.' },
  { key: 'Excerpt', description: 'Short summary, max 240 characters.', example: 'A look at the new season' },
  { key: 'Author', description: 'Author name, max 120 characters.', example: 'Sana Khan' },
  { key: 'Tags', description: 'Tags separated by ";".', example: 'summer;style' },
  { key: 'Status', description: 'draft, published or scheduled (default draft). Scheduled needs a future Publish Date.', example: 'draft' },
  { key: 'Publish Date', description: 'Only for scheduled posts: a future date/time, e.g. 2030-01-31 09:00 or ISO format.', example: '' },
  { key: 'SEO Title', description: 'Max 70 characters.', example: '' },
  { key: 'SEO Description', description: 'Max 320 characters.', example: '' },
];

export const BLOG_POST_IMPORT_MAX_ROWS = 500;
const MAX_BLOCKS = 60;
const MAX_PARAGRAPH = 2000;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ciExact = (s: string) => new RegExp(`^${escapeRegex(s)}$`, 'i');

/** Plain text -> the editor's real `paragraph` blocks. Tags are stripped, not
 *  allowed: blocks hold text and the storefront renders them as text. */
export function bodyToBlocks(raw: string): { type: 'paragraph'; settings: { text: string } }[] {
  const text = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n');
  const blocks: { type: 'paragraph'; settings: { text: string } }[] = [];
  for (const para of text.split(/\n{2,}/)) {
    let p = para.replace(/\s*\n\s*/g, ' ').trim();
    while (p.length > 0) {
      let chunk = p.slice(0, MAX_PARAGRAPH);
      if (p.length > MAX_PARAGRAPH) {
        const cut = chunk.lastIndexOf(' ');
        if (cut > MAX_PARAGRAPH / 2) chunk = chunk.slice(0, cut);
      }
      blocks.push({ type: 'paragraph', settings: { text: chunk.trim() } });
      p = p.slice(chunk.length).trim();
    }
  }
  return blocks;
}

export interface BlogPostImportDeps {
  blogModel: any;
  blogPostModel: any;
  /** StoreBlogService-like: the REAL create/update/publish path. */
  blogService: {
    ensureDefaultBlog(storeId: string): Promise<any>;
    createPost(storeId: string, sellerId: string, dto: any): Promise<any>;
    updateContent(storeId: string, sellerId: string, postId: string, dto: any): Promise<any>;
    updatePost(storeId: string, sellerId: string, postId: string, dto: any): Promise<any>;
    publish(storeId: string, sellerId: string, postId: string, scheduledAt?: string | null): Promise<any>;
    deletePost(storeId: string, sellerId: string, postId: string): Promise<any>;
  };
}

function parseFutureDate(raw: string): Date {
  const d = new Date(raw.trim().replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) throw new BulkRowError('Publish Date is not a valid date (use e.g. 2030-01-31 09:00)');
  if (d.getTime() <= Date.now()) throw new BulkRowError('Publish Date must be in the future for a scheduled post');
  return d;
}

export async function importBlogPostsCsv(deps: BlogPostImportDeps, sellerId: string, storeId: string, text: string) {
  const { blogModel, blogPostModel, blogService } = deps;

  return runBulkImport({
    text,
    columns: BLOG_POST_IMPORT_COLUMNS,
    maxRows: BLOG_POST_IMPORT_MAX_ROWS,
    label: 'post',
    fileDedupeKey: (r) => {
      if (!r.Title && !r.Slug) return null;
      return r.Slug ? r.Slug.toLowerCase() : slugify(r.Title);
    },
    handler: async (r) => {
      const title = r.Title.trim();
      if (!title) throw new BulkRowError('Title is required');
      if (title.length > 120) throw new BulkRowError('Title cannot be more than 120 characters');
      const slug = (r.Slug ? r.Slug.trim().toLowerCase() : slugify(title)).slice(0, 100);
      if (!slug || !SLUG_RE.test(slug)) throw new BulkRowError('Slug must be lowercase letters, numbers and hyphens only');
      if (r.Excerpt.length > 240) throw new BulkRowError('Excerpt cannot be more than 240 characters');
      if (r.Author.length > 120) throw new BulkRowError('Author cannot be more than 120 characters');
      if (r['SEO Title'].length > 70) throw new BulkRowError('SEO Title cannot be more than 70 characters');
      if (r['SEO Description'].length > 320) throw new BulkRowError('SEO Description cannot be more than 320 characters');
      const status = parseEnumCell(r.Status, 'Status', ['draft', 'published', 'scheduled'] as const) ?? 'draft';
      let scheduledAt: Date | null = null;
      if (status === 'scheduled') {
        if (!r['Publish Date']) throw new BulkRowError('Publish Date is required for a scheduled post');
        scheduledAt = parseFutureDate(r['Publish Date']);
      }
      const tags = parseListCell(r.Tags);
      if (tags.length > 30 || tags.some((t) => t.length > 50)) throw new BulkRowError('Tags: at most 30 tags of 50 characters each');
      const blocks = r.Body ? bodyToBlocks(r.Body) : [];
      if (blocks.length > MAX_BLOCKS) throw new BulkRowError(`Body is too long (more than ${MAX_BLOCKS} paragraphs)`);

      const existing = await blogPostModel.findOne({ storeId, slug: String(slug), isDelete: false });
      if (existing) return { outcome: 'skipped', note: `A post with slug "${slug}" already exists` };

      let blogId: string;
      if (r.Blog) {
        const blog = await blogModel.findOne({
          storeId,
          isDelete: false,
          $or: [{ title: ciExact(r.Blog) }, { slug: ciExact(r.Blog) }],
        });
        if (!blog) throw new BulkRowError(`Blog "${r.Blog}" was not found in this store`);
        blogId = String(blog._id);
      } else {
        blogId = String((await blogService.ensureDefaultBlog(storeId))._id);
      }

      const created = await blogService.createPost(storeId, sellerId, {
        title,
        slug,
        blogId,
        ...(r.Excerpt ? { excerpt: r.Excerpt } : {}),
        ...(r.Author ? { authorName: r.Author } : {}),
        ...(r['SEO Title'] ? { seoTitle: r['SEO Title'] } : {}),
        ...(r['SEO Description'] ? { seoDescription: r['SEO Description'] } : {}),
      });
      const postId = String(created.data._id);
      try {
        if (blocks.length) await blogService.updateContent(storeId, sellerId, postId, { content: blocks });
        if (tags.length) await blogService.updatePost(storeId, sellerId, postId, { tags });
        if (status === 'published') await blogService.publish(storeId, sellerId, postId);
        else if (status === 'scheduled') await blogService.publish(storeId, sellerId, postId, (scheduledAt as Date).toISOString());
      } catch (err) {
        // Never leave a half-built post behind: a re-upload would skip it.
        await blogService.deletePost(storeId, sellerId, postId).catch(() => undefined);
        throw err;
      }
      return { outcome: 'created' };
    },
  });
}
