/* eslint-disable prettier/prettier */

export const QUEUE_NAMES = {
  STRIPE_WEBHOOKS: 'stripe-webhooks',
  SUBSCRIPTION_EMAILS: 'subscription-emails',
  SEO_SITEMAP: 'seo-sitemap',
  SEO_AUDIT: 'seo-audit',
  SEO_AI: 'seo-ai',
} as const;

export const STRIPE_WEBHOOK_JOB = 'process-stripe-event';
export const SUBSCRIPTION_EMAIL_JOB = 'send-subscription-email';

export const SEO_SITEMAP_REGENERATE_JOB = 'regenerate-sitemap';
export const SEO_AUDIT_RUN_JOB = 'run-audit';
export const SEO_AI_GENERATE_JOB = 'generate-suggestion';
export const SEO_AI_GENERATE_BULK_JOB = 'generate-suggestion-bulk';
