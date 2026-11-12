/* eslint-disable prettier/prettier */
import { ConflictException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { fromMinor } from '@/common/money-minor.util';

export interface CashMovementInput {
  storeId: string; sessionId: string; amountMinor: number; exp: number; reason: string; employeeId: string; category: string; refType: string; refId: string;
  /** cash_out (default) takes money out of the drawer, cash_in puts it in */
  type?: 'cash_in' | 'cash_out';
  /** a client-made id: the same movement replayed (a retry, an offline queue) is applied ONCE */
  requestId?: string | null;
  /** the device's own time for a movement made offline */
  occurredAt?: Date | null;
  approvedBy?: string | null;
  note?: string | null;
}

/**
 * Cash moved in / out of an OPEN shift's drawer by something other than the plain "cash out" button (G3.4 supplier payments; G3.5 cash in / out, safe drops and drawer expenses).
 * It pushes a `cash_in` / `cash_out` row (decimal + minor twin) onto the shift, inside the caller's transaction, so the shift's expected cash moves exactly when the business
 * document exists. Refuses when the shift is not open or belongs to another store: the money must move in a till that is counting.
 * Returns `'applied'`, or `'duplicate'` when a row with the same `requestId` is already on the shift (nothing was written).
 */
export async function recordCashMovement(registerSessionModel: any, tx: ClientSession | undefined, p: CashMovementInput): Promise<'applied' | 'duplicate'> {
  const row = {
    type: p.type ?? 'cash_out', amount: fromMinor(p.amountMinor, p.exp), amountMinor: p.amountMinor, reason: p.reason, employeeId: p.employeeId, category: p.category, refType: p.refType, refId: p.refId,
    requestId: p.requestId ?? null, occurredAt: p.occurredAt ?? null, approvedBy: p.approvedBy ?? null, note: p.note ?? null, createdAt: new Date(),
  };
  const filter: any = { _id: p.sessionId, storeId: p.storeId, status: 'open' };
  if (p.requestId) filter['cashAdjustments.requestId'] = { $ne: p.requestId };
  const hit = await registerSessionModel.findOneAndUpdate(filter, { $push: { cashAdjustments: row } }, tx ? { session: tx } : undefined);
  if (hit) return 'applied';
  if (p.requestId) {
    const dup = await registerSessionModel.findOne({ _id: p.sessionId, storeId: p.storeId, 'cashAdjustments.requestId': p.requestId }, null, tx ? { session: tx } : undefined).select('_id').lean();
    if (dup) return 'duplicate';
  }
  throw new ConflictException({ statusCode: 409, code: 'NO_OPEN_SHIFT', message: 'This needs an open shift on this till (the shift may have been closed).' });
}

/** G3.4 name kept: cash taken out of the drawer. */
export async function recordCashOut(registerSessionModel: any, tx: ClientSession | undefined, p: Omit<CashMovementInput, 'type'>): Promise<void> {
  await recordCashMovement(registerSessionModel, tx, { ...p, type: 'cash_out' });
}
