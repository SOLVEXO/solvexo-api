import { BadRequestException } from '@nestjs/common';

/**
 * Google's site-verification token is a short URL-safe string (letters, digits, `-`, `_`). It is the `content` value of
 * `<meta name="google-site-verification" content="…">`. Sellers usually paste the whole tag, so the token is pulled out
 * of it. Only that strict character set is ever stored, so the value can never carry markup into a storefront's <head>.
 */
const TOKEN = /^[A-Za-z0-9_-]{10,200}$/;

/** Returns the clean token, `null` when the field was cleared, or throws when the input is not a Google token. */
export function parseGoogleSiteVerification(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const fromTag = /content\s*=\s*["']([^"']+)["']/i.exec(raw);
  const token = (fromTag ? fromTag[1] : raw).trim();
  if (!TOKEN.test(token)) {
    throw new BadRequestException('That is not a valid Google verification code. Paste the meta tag Google gave you, or just the value inside content="…".');
  }
  return token;
}
