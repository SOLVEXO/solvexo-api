/* eslint-disable prettier/prettier */

export const QUEUE_NAMES = {
  STRIPE_WEBHOOKS: 'stripe-webhooks',
  SUBSCRIPTION_EMAILS: 'subscription-emails',
} as const;

export const STRIPE_WEBHOOK_JOB = 'process-stripe-event';
export const SUBSCRIPTION_EMAIL_JOB = 'send-subscription-email';
