/* eslint-disable prettier/prettier */
import { bodyToBlocks, importBlogPostsCsv } from './blog-posts-bulk-import';

function setup(existingSlugs: string[] = []) {
  const slugs = new Set(existingSlugs);
  const calls: string[] = [];
  const deps: any = {
    blogModel: {
      findOne: jest.fn(async (q: any) => (q.storeId === 'store1' && q.$or?.[0]?.title?.test('News') ? { _id: 'blogNews' } : null)),
    },
    blogPostModel: { findOne: jest.fn(async (q: any) => (slugs.has(q.slug) ? { _id: 'old' } : null)) },
    blogService: {
      ensureDefaultBlog: jest.fn(async () => ({ _id: 'defBlog' })),
      createPost: jest.fn(async (_s: string, _u: string, dto: any) => {
        slugs.add(dto.slug);
        calls.push('create:' + dto.slug + ':' + dto.blogId);
        return { data: { _id: 'post_' + dto.slug } };
      }),
      updateContent: jest.fn(async (_s: string, _u: string, id: string, dto: any) => { calls.push('content:' + dto.content.length); }),
      updatePost: jest.fn(async (_s: string, _u: string, id: string, dto: any) => { calls.push('tags:' + dto.tags.join(',')); }),
      publish: jest.fn(async (_s: string, _u: string, id: string, at?: string) => { calls.push('publish:' + (at ? 'sched' : 'now')); }),
      deletePost: jest.fn(async () => { calls.push('delete'); }),
    },
  };
  return { deps, calls };
}

describe('blog posts bulk import', () => {
  it('converts plain text / simple HTML into paragraph blocks without keeping tags', () => {
    const blocks = bodyToBlocks('<p>Hello <b>world</b></p><p>Second &amp; last</p>');
    expect(blocks).toEqual([
      { type: 'paragraph', settings: { text: 'Hello world' } },
      { type: 'paragraph', settings: { text: 'Second & last' } },
    ]);
    expect(bodyToBlocks('a\n\nb').length).toBe(2);
    expect(bodyToBlocks('x'.repeat(4500)).every((b) => b.settings.text.length <= 2000)).toBe(true);
  });

  it('creates posts through the service (default blog, auto slug, content, tags, publish)', async () => {
    const { deps, calls } = setup();
    const res = await importBlogPostsCsv(deps, 'seller1', 'store1', 'Title,Body,Tags,Status\nHello World,"Para one.\n\nPara two",a;b,published');
    expect(res.data.created).toBe(1);
    expect(calls).toEqual(['create:hello-world:defBlog', 'content:2', 'tags:a,b', 'publish:now']);
  });

  it('uses a named existing blog and fails an unknown one', async () => {
    const { deps, calls } = setup();
    const res = await importBlogPostsCsv(deps, 's', 'store1', 'Title,Blog\nA,News\nB,Nope');
    expect(calls[0]).toBe('create:a:blogNews');
    expect(res.data.failed[0].error).toContain('Nope');
  });

  it('skips an existing slug, fails a duplicate slug in the file, rejects bad slug/status/date', async () => {
    const { deps } = setup(['taken']);
    const res = await importBlogPostsCsv(deps, 's', 'store1', 'Title,Slug,Status,Publish Date\nT,taken,,\nU,u-1,,\nV,u-1,,\nW,Bad Slug!,,\nX,x-1,scheduled,\nY,y-1,scheduled,2001-01-01');
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    const errs = res.data.failed.map((f) => f.error).join('|');
    expect(errs).toContain('Duplicate');
    expect(errs).toContain('Slug');
    expect(errs).toContain('Publish Date is required');
    expect(errs).toContain('future');
  });

  it('deletes a half-built post when a later step fails, and requires the Title column', async () => {
    const { deps, calls } = setup();
    deps.blogService.updateContent = jest.fn(async () => { throw new Error('boom'); });
    const res = await importBlogPostsCsv(deps, 's', 'store1', 'Title,Body\nA,hello');
    expect(res.data.failedCount).toBe(1);
    expect(calls).toContain('delete');
    await expect(importBlogPostsCsv(deps, 's', 'store1', 'Body\nhello')).rejects.toThrow('Title');
  });
});
