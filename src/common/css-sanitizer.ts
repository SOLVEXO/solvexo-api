/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

// Deliberately conservative — the theme code editor's "no arbitrary JS
// execution" security model (see the theme ecosystem plan) means seller
// custom CSS must never be able to: load external resources (`@import`,
// remote `url(...)`), execute script-like values (`javascript:`,
// `expression(...)`, old-IE-only but cheap to block), or break out of the
// `<style>` tag it's rendered inside (`</style`, `<script`). This is a
// deny-list, not a full CSS parser — good enough to block the known-bad
// patterns without needing a new dependency; it does not attempt to
// validate that the CSS is otherwise well-formed.
const MAX_CUSTOM_CSS_LENGTH = 20_000;

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /@import/i, reason: '@import is not allowed' },
  { pattern: /url\s*\(\s*['"]?\s*javascript:/i, reason: 'javascript: URLs are not allowed' },
  { pattern: /expression\s*\(/i, reason: 'expression() is not allowed' },
  { pattern: /<\s*\/?\s*(script|style|iframe)/i, reason: 'HTML tags are not allowed inside custom CSS' },
  { pattern: /javascript\s*:/i, reason: 'javascript: is not allowed' },
];

export function sanitizeCustomCss(css: string | null | undefined): string | null {
  if (css === null || css === undefined || css === '') return null;
  if (typeof css !== 'string') throw new BadRequestException('customCss must be a string');
  if (css.length > MAX_CUSTOM_CSS_LENGTH) {
    throw new BadRequestException(`customCss cannot exceed ${MAX_CUSTOM_CSS_LENGTH} characters`);
  }
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(css)) throw new BadRequestException(`Invalid CSS: ${reason}`);
  }
  return css;
}
