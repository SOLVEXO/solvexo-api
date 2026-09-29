import { UAParser } from 'ua-parser-js';

/**
 * Readable "Chrome · Windows" label for a raw User-Agent string — same
 * `req.headers['user-agent']` this codebase already stores verbatim on
 * ActivityLog.userAgent (see activity-log.service.ts), just parsed for
 * display instead of dumping the raw string on the reader.
 */
export function describeUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const { browser, os } = UAParser(userAgent);
  const parts = [browser?.name, os?.name].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
