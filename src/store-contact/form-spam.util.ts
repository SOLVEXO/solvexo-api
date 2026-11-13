/* eslint-disable prettier/prettier */

export type SpamReason = 'honeypot' | 'links';

const LINK_RE = /(https?:\/\/|www\.)\S+/gi;
const MAX_LINKS = 3;

/**
 * Cheap checks that catch most bot posts without blocking a real visitor: many links in the text, or the hidden trap field filled in.
 * A message that trips one is NOT thrown away: it goes to the Spam tab so the seller can rescue a false alarm.
 */
export function detectSpam(texts: string[], honeypot?: string): SpamReason | null {
  if (honeypot && honeypot.trim()) return 'honeypot';
  let links = 0;
  for (const t of texts) links += (t.match(LINK_RE) ?? []).length;
  return links > MAX_LINKS ? 'links' : null;
}
