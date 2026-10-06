import { stripUnpublished } from './store-pages.service';

describe('stripUnpublished', () => {
  it('removes draft and versions but keeps live fields', () => {
    const out: any = stripUnpublished({ _id: '1', slug: 'x', sections: [1], draft: { sections: [2] }, versions: [{}] });
    expect(out.draft).toBeUndefined();
    expect(out.versions).toBeUndefined();
    expect(out.sections).toEqual([1]);
    expect(out.slug).toBe('x');
  });
});
