/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

/**
 * G2.4 — reasons for the actions that undo or discard money: a REASON CODE from a fixed list (the till shows a picker) plus an optional
 * free-text note. Old app builds send only free text: that is still accepted (stored with code `not_provided`), so nothing breaks.
 */
export const REASON_CODES = {
  refund: ['wrong_item', 'damaged_or_defective', 'customer_changed_mind', 'price_error', 'duplicate_charge', 'other'],
  void: ['cashier_error', 'customer_cancelled', 'wrong_total', 'payment_problem', 'other'],
  discard: ['customer_left', 'wrong_items', 'duplicate', 'no_longer_needed', 'other'],
} as const;
export type ReasonKind = keyof typeof REASON_CODES;

export function normalizeReason(kind: ReasonKind, code?: string | null, note?: string | null): { code: string; note: string | null } {
  const n = (note ?? '').toString().trim().slice(0, 300) || null;
  if (code === undefined || code === null || code === '') return { code: 'not_provided', note: n };
  if (!(REASON_CODES[kind] as readonly string[]).includes(code)) {
    throw new BadRequestException({ statusCode: 400, code: 'INVALID_REASON_CODE', message: `Unknown ${kind} reason`, allowed: REASON_CODES[kind] });
  }
  // "other" has no meaning without words
  if (code === 'other' && !n) throw new BadRequestException({ statusCode: 400, code: 'REASON_NOTE_REQUIRED', message: 'Please describe the reason' });
  return { code, note: n };
}
