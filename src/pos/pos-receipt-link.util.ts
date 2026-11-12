/* eslint-disable prettier/prettier */
import { API_PUBLIC_ORIGIN } from '@/common/api-origin';

/** G4.9: the store's public id in the offline link (a store slug) and the till's client key (IdempotencyIntentStore: `pos-<µs since epoch>-<24 hex>`). */
export const PUBLIC_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const CLIENT_KEY = /^pos-(\d{13,17})-([0-9a-f]{24})$/;
/** G4.9: the base of the offline-buildable link for a store — `<origin>/r/s/<store slug>/`; the till appends the sale's client key. */
export function offlineLinkBaseOf(slug: string | null | undefined): { storePublicId: string | null; receiptLinkBase: string | null } {
  const ok = !!slug && PUBLIC_SLUG.test(slug);
  return { storePublicId: ok ? slug! : null, receiptLinkBase: ok ? `${API_PUBLIC_ORIGIN}/r/s/${slug}/` : null };
}
/** A client-key link older than this answers 404, not "syncing" (an offline sale must sync well within it). */
export const CLIENT_LINK_WINDOW_MS = 30 * 86_400_000;
export const SYNCING_PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="30"><title>Receipt syncing</title><body style="font:16px -apple-system,Segoe UI,sans-serif;text-align:center;padding:64px 16px;color:#1b1d21"><h1 style="font-size:20px">Your receipt is syncing</h1><p style="color:#5b616b">The shop\'s till has not sent this sale yet. This page refreshes by itself — check again in a little while.</p></body></html>';
