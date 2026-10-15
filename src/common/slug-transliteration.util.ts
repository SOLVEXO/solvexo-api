/**
 * Slug transliteration utilities.
 * Converts Urdu/Arabic/RTL text to English for URL-safe slugs.
 */

/**
 * Basic Urdu to English transliteration map.
 * This is a simplified mapping - for production, consider using a library
 * like `transliteration` or an API-based service.
 */
const URDU_TO_ENGLISH: Record<string, string> = {
  'ا': 'a',
  'آ': 'aa',
  'ب': 'b',
  'پ': 'p',
  'ت': 't',
  'ٹ': 'tt',
  'ث': 's',
  'ج': 'j',
  'چ': 'ch',
  'ح': 'h',
  'خ': 'kh',
  'د': 'd',
  'ڈ': 'dd',
  'ذ': 'z',
  'ر': 'r',
  'ڑ': 'rr',
  'ز': 'z',
  'ژ': 'zh',
  'س': 's',
  'ش': 'sh',
  'ص': 's',
  'ض': 'z',
  'ط': 't',
  'ظ': 'z',
  'ع': 'a',
  'غ': 'gh',
  'ف': 'f',
  'ق': 'q',
  'ک': 'k',
  'گ': 'g',
  'ل': 'l',
  'م': 'm',
  'ن': 'n',
  'ں': 'n',
  'و': 'w',
  'ہ': 'h',
  'ھ': 'h',
  'ی': 'y',
  'ے': 'e',
  'ء': '',
  'ؤ': 'o',
};

/**
 * Arabic to English transliteration map.
 */
const ARABIC_TO_ENGLISH: Record<string, string> = {
  'ا': 'a',
  'أ': 'a',
  'إ': 'i',
  'آ': 'aa',
  'ب': 'b',
  'ت': 't',
  'ث': 'th',
  'ج': 'j',
  'ح': 'h',
  'خ': 'kh',
  'د': 'd',
  'ذ': 'dh',
  'ر': 'r',
  'ز': 'z',
  'س': 's',
  'ش': 'sh',
  'ص': 's',
  'ض': 'd',
  'ط': 't',
  'ظ': 'z',
  'ع': 'a',
  'غ': 'gh',
  'ف': 'f',
  'ق': 'q',
  'ك': 'k',
  'ل': 'l',
  'م': 'm',
  'ن': 'n',
  'ه': 'h',
  'ة': 'a',
  'و': 'w',
  'ي': 'y',
  'ى': 'a',
  'ئ': 'e',
};

/**
 * Transliterate Urdu text to English.
 */
export function transliterateUrdu(text: string): string {
  let result = '';
  for (const char of text) {
    result += URDU_TO_ENGLISH[char] || char;
  }
  return result;
}

/**
 * Transliterate Arabic text to English.
 */
export function transliterateArabic(text: string): string {
  let result = '';
  for (const char of text) {
    result += ARABIC_TO_ENGLISH[char] || char;
  }
  return result;
}

/**
 * Transliterate text based on language.
 */
export function transliterate(text: string, lang: string): string {
  if (lang === 'ur') {
    return transliterateUrdu(text);
  }
  if (lang === 'ar') {
    return transliterateArabic(text);
  }
  // For English and other Latin scripts, return as-is
  return text;
}

/**
 * Create a URL-safe slug from text.
 * Handles transliteration for RTL languages.
 */
export function createSlug(text: string, lang: string = 'en'): string {
  // Transliterate if RTL language
  const transliterated = transliterate(text, lang);
  
  // Convert to lowercase
  let slug = transliterated.toLowerCase();
  
  // Replace spaces with hyphens
  slug = slug.replace(/\s+/g, '-');
  
  // Remove special characters except hyphens
  slug = slug.replace(/[^a-z0-9-]/g, '');
  
  // Remove consecutive hyphens
  slug = slug.replace(/-+/g, '-');
  
  // Remove leading/trailing hyphens
  slug = slug.replace(/^-+|-+$/g, '');
  
  // Limit length
  if (slug.length > 100) {
    slug = slug.substring(0, 100).replace(/-+$/, '');
  }
  
  return slug || 'untitled';
}

/**
 * Create a localized slug with language prefix.
 * Example: /ur/product-name
 */
export function createLocalizedSlug(text: string, lang: string): string {
  const slug = createSlug(text, lang);
  return `${lang}/${slug}`;
}
