/* eslint-disable prettier/prettier */
import { ConflictException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { fromMinor } from '@/common/money-minor.util';

/**
 * Cash taken out of an OPEN shift's drawer by something other than the plain "cash out" button (G3.4 supplier payments; G3.5 expenses / safe drops reuse it).
 * It pushes a `cash_out` row (decimal + minor twin) onto the shift, inside the caller's transaction, so the shift's expected cash goes down exactly when the
 * business document (the payment) exists. Refuses when the shift is not open or belongs to another store: the money must come out of a till that is counting.
 */
export async function recordCashOut(
  registerSessionModel: any,
  tx: ClientSession | undefined,
  p: { storeId: string; sessionId: string; amountMinor: number; exp: number; reason: string; employeeId: string; category: string; refType: string; refId: string },
): Promise<void> {
  const row = { type: 'cash_out', amount: fromMinor(p.amountMinor, p.exp), amountMinor: p.amountMinor, reason: p.reason, employeeId: p.employeeId, category: p.category, refType: p.refType, refId: p.refId, createdAt: new Date() };
  const hit = await registerSessionModel.findOneAndUpdate({ _id: p.sessionId, storeId: p.storeId, status: 'open' }, { $push: { cashAdjustments: row } }, tx ? { session: tx } : undefined);
  if (!hit) throw new ConflictException({ statusCode: 409, code: 'NO_OPEN_SHIFT', message: 'Paying cash from the drawer needs an open shift on this till.' });
}
