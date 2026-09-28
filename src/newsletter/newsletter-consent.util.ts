/* eslint-disable prettier/prettier */
import * as crypto from 'crypto';
import { Model } from 'mongoose';
import { API_PUBLIC_ORIGIN } from '../common/api-origin';
import { NewsletterSubscriberDocument } from './schemas/newsletter-subscriber.schema';

export function newsletterUnsubscribeUrl(token: string): string {
  return `${API_PUBLIC_ORIGIN}/api/newsletter/unsubscribe/${token}`;
}

export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

export interface SetConsentInput {
  storeId: string | null;
  email: string;
  subscribed: boolean;
  source: string;
  userId?: string | null;
}

export interface SetConsentResult {
  /** Consent state before this call (false when no row existed). */
  wasActive: boolean;
  isActive: boolean;
  unsubscribeToken: string | null;
}

/**
 * The one write path for marketing consent — newsletter signups, the
 * seller's per-customer toggle and the checkout checkbox all funnel here so
 * the subscriber row (the source of truth campaigns read from) can never
 * drift between entry points.
 *
 * Unsubscribing never creates a row; re-subscribing a row that was
 * unsubscribed rotates its token so an old unsubscribe link stops working
 * against the new consent.
 */
export async function setMarketingConsent(
  model: Model<NewsletterSubscriberDocument>,
  input: SetConsentInput,
): Promise<SetConsentResult> {
  const email = normalizeEmail(input.email);
  const storeId = input.storeId ?? null;
  const existing = await model.findOne({ storeId, email });

  if (!input.subscribed) {
    if (!existing) return { wasActive: false, isActive: false, unsubscribeToken: null };
    const wasActive = existing.isActive;
    if (wasActive) {
      existing.isActive = false;
      existing.unsubscribedAt = new Date();
      await existing.save();
    }
    return { wasActive, isActive: false, unsubscribeToken: existing.unsubscribeToken };
  }

  if (existing) {
    const wasActive = existing.isActive;
    if (!wasActive) {
      existing.isActive = true;
      existing.unsubscribeToken = crypto.randomBytes(24).toString('hex');
      existing.unsubscribedAt = undefined;
      existing.consentAt = new Date();
      existing.source = input.source;
      existing.pendingConfirmation = false;
      existing.confirmToken = null;
    }
    if (input.userId && !existing.userId) existing.userId = input.userId;
    if (existing.isModified()) await existing.save();
    return { wasActive, isActive: true, unsubscribeToken: existing.unsubscribeToken };
  }

  const token = crypto.randomBytes(24).toString('hex');
  try {
    await model.create({
      storeId,
      email,
      userId: input.userId ?? null,
      source: input.source,
      unsubscribeToken: token,
      consentAt: new Date(),
      isActive: true,
    });
  } catch (e: any) {
    // Two concurrent signups for the same (store, email) — the other one won,
    // and it recorded the same consent this call was about to.
    if (e?.code !== 11000) throw e;
    const row = await model.findOne({ storeId, email }).lean();
    return { wasActive: false, isActive: true, unsubscribeToken: row?.unsubscribeToken ?? null };
  }
  return { wasActive: false, isActive: true, unsubscribeToken: token };
}

/**
 * Double opt-in sign-up: records the request as `pendingConfirmation` (not
 * active — campaigns never reach it) with a fresh confirm token to email.
 * Returns `alreadyActive` when there's nothing to confirm.
 */
export async function setPendingConsent(
  model: Model<NewsletterSubscriberDocument>,
  input: Omit<SetConsentInput, 'subscribed'>,
): Promise<{ alreadyActive: boolean; confirmToken: string | null }> {
  const email = normalizeEmail(input.email);
  const storeId = input.storeId ?? null;
  const confirmToken = crypto.randomBytes(24).toString('hex');
  const existing = await model.findOne({ storeId, email });

  if (existing?.isActive) return { alreadyActive: true, confirmToken: null };

  if (existing) {
    existing.pendingConfirmation = true;
    existing.confirmToken = confirmToken;
    existing.source = input.source;
    if (input.userId && !existing.userId) existing.userId = input.userId;
    await existing.save();
    return { alreadyActive: false, confirmToken };
  }

  try {
    await model.create({
      storeId, email, userId: input.userId ?? null, source: input.source,
      unsubscribeToken: crypto.randomBytes(24).toString('hex'),
      isActive: false, pendingConfirmation: true, confirmToken, consentAt: null,
    });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    const row = await model.findOne({ storeId, email }).lean();
    if (row?.isActive) return { alreadyActive: true, confirmToken: null };
    return { alreadyActive: false, confirmToken: row?.confirmToken ?? null };
  }
  return { alreadyActive: false, confirmToken };
}
