/* eslint-disable prettier/prettier */
import { resolveTemplateOwnerResource } from './collection-template.service';

describe('resolveTemplateOwnerResource (Phase 9 — Dynamic Sources)', () => {
  it('maps product/collection templates to their own ownerResource', () => {
    expect(resolveTemplateOwnerResource('product', 'default')).toBe('product');
    expect(resolveTemplateOwnerResource('collection', 'default')).toBe('collection');
  });

  it('maps the blog-article shared template to "article" (a real singular resource per view)', () => {
    expect(resolveTemplateOwnerResource('page', 'blog-article')).toBe('article');
  });

  it('returns null for templates with no single real resource (search/cart/blog-index)', () => {
    expect(resolveTemplateOwnerResource('page', 'search')).toBeNull();
    expect(resolveTemplateOwnerResource('page', 'cart')).toBeNull();
    expect(resolveTemplateOwnerResource('page', 'blog-index')).toBeNull();
  });

  it('returns null for an alternate product/collection template with a non-default key too — resourceType alone decides it', () => {
    expect(resolveTemplateOwnerResource('product', 'seasonal')).toBe('product');
  });
});
