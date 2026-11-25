import { productCoverImage } from './pos-cover-image.util';

describe('productCoverImage', () => {
  it('reads the schema field `images` first', () => {
    expect(productCoverImage({ images: ['https://img/a.jpg', 'https://img/b.jpg'] })).toBe('https://img/a.jpg');
  });
  it('falls back to the legacy names for old documents', () => {
    expect(productCoverImage({ gallery: ['https://img/g.jpg'] })).toBe('https://img/g.jpg');
    expect(productCoverImage({ coverImages: ['https://img/c.jpg'] })).toBe('https://img/c.jpg');
  });
  it('is null when there is no usable picture', () => {
    expect(productCoverImage({ images: [] })).toBeNull();
    expect(productCoverImage({ images: [''] })).toBeNull();
    expect(productCoverImage(null)).toBeNull();
  });
});
