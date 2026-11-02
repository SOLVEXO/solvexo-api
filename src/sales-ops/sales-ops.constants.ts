/* eslint-disable prettier/prettier */

/** Pipeline stages, in order. A lead only moves forward automatically (sign-up → trial → paying); people can move it anywhere. */
export const LEAD_STAGES = [
  'new',
  'contacted',
  'demo',
  'trial',
  'won',
  'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_SOURCES = [
  'website_form',
  'contact_message',
  'manual',
  'import',
  'stalled_signup',
  'whatsapp',
  'social',
  'referral',
  'event',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LOST_REASONS = [
  'price',
  'chose_competitor',
  'no_response',
  'not_a_fit',
  'timing',
  'other',
] as const;

export const ACTIVITY_TYPES = [
  'note',
  'call',
  'whatsapp',
  'meeting',
  'email',
  'stage_change',
  'owner_change',
  'system',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
