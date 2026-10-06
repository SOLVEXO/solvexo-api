import { randomInt, timingSafeEqual } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';

/** Max wrong guesses (per issued code) before the code is invalidated and a new one must be requested. */
export const OTP_MAX_ATTEMPTS = 5;

/** Cryptographically secure 6-digit code (never `Math.random`). */
export function generateOtp(): string {
  return randomInt(100000, 1000000).toString();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Checks `supplied` against the OTP stored on the account document and counts
 * the attempt atomically ($inc), so parallel guesses can't dodge the cap.
 * After OTP_MAX_ATTEMPTS wrong guesses the stored code is wiped — the user
 * must request a new one (which resets the counter: set `otpAttempts = 0`
 * wherever a code is issued). Throws UnauthorizedException on any failure;
 * returns normally only for a correct code that is still within its budget.
 * Expiry is checked by the caller (kept where it already was).
 */
export async function assertOtpAttempt(model: any, userId: unknown, supplied: unknown): Promise<void> {
  const snapshot = await model
    .findOneAndUpdate({ _id: userId }, { $inc: { otpAttempts: 1 } }, { new: true })
    .select('otp otpAttempts')
    .lean();
  const stored: string | null | undefined = snapshot?.otp;
  if (!snapshot || !stored) {
    throw new UnauthorizedException('Invalid OTP');
  }
  const attempts: number = snapshot.otpAttempts ?? 1;
  const matches = typeof supplied === 'string' && safeEqual(stored, supplied);

  if (matches && attempts <= OTP_MAX_ATTEMPTS) {
    // Correct code: give the (still valid) code a fresh budget. The caller
    // nulls the code right after on the consuming paths.
    await model.updateOne({ _id: userId }, { $set: { otpAttempts: 0 } });
    return;
  }

  if (attempts >= OTP_MAX_ATTEMPTS) {
    await model.updateOne({ _id: userId }, { $set: { otp: null, otpExpiresAt: null } });
    throw new UnauthorizedException('Too many incorrect attempts. Please request a new code.');
  }
  throw new UnauthorizedException('Invalid OTP');
}
