import { transliterateUrdu, transliterateArabic, transliterate, createSlug, createLocalizedSlug } from './slug-transliteration.util';

// Urdu and Arabic are written without short vowels, so transliteration is letter by letter: کتاب (k-t-a-b) becomes
// "ktab", not "kitab" (inserting the missing vowels would need a dictionary).
describe('Slug Transliteration', () => {
  describe('transliterateUrdu', () => {
    it('should transliterate basic Urdu characters', () => {
      expect(transliterateUrdu('السلام')).toBe('alslam');
      expect(transliterateUrdu('کتاب')).toBe('ktab');
      expect(transliterateUrdu('پاکستان')).toBe('pakstan');
    });

    it('should handle mixed Urdu and English', () => {
      expect(transliterateUrdu('کتاب-book')).toBe('ktab-book');
    });

    it('should handle empty string', () => {
      expect(transliterateUrdu('')).toBe('');
    });
  });

  describe('transliterateArabic', () => {
    it('should transliterate basic Arabic characters', () => {
      expect(transliterateArabic('السلام')).toBe('alslam');
      expect(transliterateArabic('كتاب')).toBe('ktab');
    });

    it('should handle mixed Arabic and English', () => {
      expect(transliterateArabic('كتاب-book')).toBe('ktab-book');
    });

    it('should handle empty string', () => {
      expect(transliterateArabic('')).toBe('');
    });
  });

  describe('transliterate', () => {
    it('should use Urdu transliteration for ur language', () => {
      expect(transliterate('کتاب', 'ur')).toBe('ktab');
    });

    it('should use Arabic transliteration for ar language', () => {
      expect(transliterate('كتاب', 'ar')).toBe('ktab');
    });

    it('should return as-is for English', () => {
      expect(transliterate('Book', 'en')).toBe('Book');
    });

    it('should return as-is for unknown languages', () => {
      expect(transliterate('Book', 'fr')).toBe('Book');
    });
  });

  describe('createSlug', () => {
    it('should create URL-safe slug from English text', () => {
      expect(createSlug('My Product Name', 'en')).toBe('my-product-name');
    });

    it('should transliterate Urdu and create slug', () => {
      expect(createSlug('کتاب', 'ur')).toBe('ktab');
    });

    it('should transliterate Arabic and create slug', () => {
      expect(createSlug('كتاب', 'ar')).toBe('ktab');
    });

    it('should handle special characters', () => {
      expect(createSlug('Product @#$ Name!', 'en')).toBe('product-name');
    });

    it('should handle multiple spaces', () => {
      expect(createSlug('My   Product   Name', 'en')).toBe('my-product-name');
    });

    it('should limit length to 100 characters', () => {
      const longText = 'a'.repeat(150);
      expect(createSlug(longText, 'en').length).toBeLessThanOrEqual(100);
    });

    it('should return untitled for empty or invalid input', () => {
      expect(createSlug('', 'en')).toBe('untitled');
      expect(createSlug('@#$%', 'en')).toBe('untitled');
    });
  });

  describe('createLocalizedSlug', () => {
    it('should create slug with language prefix', () => {
      expect(createLocalizedSlug('My Product', 'en')).toBe('en/my-product');
    });

    it('should handle Urdu with prefix', () => {
      expect(createLocalizedSlug('کتاب', 'ur')).toBe('ur/ktab');
    });

    it('should handle Arabic with prefix', () => {
      expect(createLocalizedSlug('كتاب', 'ar')).toBe('ar/ktab');
    });
  });
});
