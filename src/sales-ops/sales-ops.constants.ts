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
  'website_chat',
  'contact_message',
  'manual',
  'import',
  'stalled_signup',
  'whatsapp',
  'social',
  'referral',
  'event',
  'field_visit',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const SOURCE_LABELS: Record<LeadSource, string> = {
  website_form: 'Book-a-demo form',
  website_chat: 'Website chat',
  contact_message: 'Contact Us message',
  manual: 'Added by hand',
  import: 'Import',
  stalled_signup: 'Stalled sign-up',
  whatsapp: 'WhatsApp',
  social: 'Social media',
  referral: 'Referral',
  event: 'Event',
  field_visit: 'Field visit',
  other: 'Other',
};

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
  'visit',
  'stage_change',
  'owner_change',
  'system',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Why a template is sent; reps pick a reason first, then a template. */
export const MESSAGE_REASONS = ['follow_up', 'demo_reminder', 'payment_reminder', 'onboarding', 'win_back', 'other'] as const;
export type MessageReason = (typeof MESSAGE_REASONS)[number];
export const MESSAGE_REASON_LABELS: Record<MessageReason, string> = {
  follow_up: 'Follow-up', demo_reminder: 'Demo reminder', payment_reminder: 'Payment reminder',
  onboarding: 'Onboarding', win_back: 'Win-back', other: 'Other',
};
export const asReason = (v: unknown): MessageReason => ((MESSAGE_REASONS as readonly string[]).includes(String(v)) ? (v as MessageReason) : 'other');
