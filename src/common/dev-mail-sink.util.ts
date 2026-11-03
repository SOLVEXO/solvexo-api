/* eslint-disable prettier/prettier */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * DEV-ONLY test hook (local full-stack runs, see dev/README.md). Both conditions must hold, so it can never be on
 * in production even if the env var leaks into a production environment:
 *   NODE_ENV !== 'production'  AND  DEV_OTP_LOG === 'true'
 * When on, EmailService does not talk to SMTP at all: it appends one JSON line per mail (to / subject / text / otp)
 * to DEV_MAIL_LOG_FILE and reports success. Nothing is exposed over HTTP.
 */
export const isDevMailSinkEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV !== 'production' && env.DEV_OTP_LOG === 'true';

/** Dev-only: switches the rate limiter off so repeated e2e runs don't trip it. Same double guard. */
export const isDevThrottleDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV !== 'production' && env.DEV_DISABLE_THROTTLE === 'true';

export function writeDevMail(mail: { to: string; subject: string; text: string }, env: NodeJS.ProcessEnv = process.env): void {
  const file = env.DEV_MAIL_LOG_FILE || 'dev/.logs/mail.log';
  const otp = /\b(\d{6})\b/.exec(mail.text)?.[1] ?? null;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), to: mail.to, subject: mail.subject, otp, text: mail.text.slice(0, 2000) }) + '\n');
}
