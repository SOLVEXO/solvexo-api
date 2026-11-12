/* eslint-disable prettier/prettier */
/**
 * Attendance (G3.6), PURE: turns the append-only event log of ONE person into work records, breaks, hours and anomaly flags.
 * Raw events are never edited: a manager's fix is a `correction` event that this function applies on top. Times are the EFFECTIVE times
 * (the device's time, or the server's when the device clock was wrong — decided when the event was written and stored in `at`).
 */
export const MAX_OPEN_HOURS = 14;          // an open record older than this is a missing clock-out
export const CLOCK_SKEW_MS = 5 * 60_000;   // device vs server time gap that is flagged
export const LATE_SYNC_FLAG_MS = 12 * 3_600_000; // an offline event that reached the server this much later is flagged for review
export const LATE_GRACE_MINUTES = 10;

export type AttendanceEventType = 'clock_in' | 'clock_out' | 'break_start' | 'break_end' | 'correction' | 'ack';
export interface AttEvent {
  id: string; type: AttendanceEventType; at: Date | string; serverAt?: Date | string; recordId?: string | null;
  flags?: string[];
  /** correction only: the record it fixes and what it sets (null clockOutAt = leave open) */
  correction?: { clockInAt?: Date | string | null; clockOutAt?: Date | string | null; voided?: boolean } | null;
  reason?: string | null; employeeId?: string | null;
}
export interface AttBreak { startAt: Date; endAt: Date | null; minutes: number }
export interface AttRecord {
  recordId: string; clockInAt: Date; clockOutAt: Date | null; status: 'open' | 'closed' | 'voided'; breaks: AttBreak[];
  workedMinutes: number; breakMinutes: number; corrected: boolean; correctionCount: number; flags: string[]; inEventId: string; outEventId: string | null;
}
export interface Anomaly { kind: string; recordId: string | null; eventId: string | null; at: Date; detail: string }

const ms = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : NaN);
const mins = (a: number, b: number) => Math.max(0, Math.round((b - a) / 60_000));

export function deriveRecords(events: AttEvent[], now: Date = new Date()): { records: AttRecord[]; anomalies: Anomaly[] } {
  const sorted = [...events].sort((a, b) => ms(a.at) - ms(b.at) || ms(a.serverAt) - ms(b.serverAt) || a.id.localeCompare(b.id));
  const anomalies: Anomaly[] = [];
  const records: AttRecord[] = [];
  let open: AttRecord | null = null;
  let openBreak: AttBreak | null = null;
  const byId = new Map<string, AttRecord>();
  const note = (kind: string, e: AttEvent, detail: string) => anomalies.push({ kind, recordId: open?.recordId ?? e.recordId ?? null, eventId: e.id, at: new Date(e.at), detail });

  for (const e of sorted) {
    const at = new Date(e.at);
    for (const f of e.flags ?? []) anomalies.push({ kind: f, recordId: e.recordId ?? open?.recordId ?? null, eventId: e.id, at, detail: f === 'device_clock_ahead' ? 'The device clock was ahead of the server — the server time was used.' : f === 'late_sync' ? 'This was recorded offline and reached the server much later.' : f });
    if (e.type === 'clock_in') {
      if (open) { note('double_clock_in', e, 'Clocked in again while already clocked in — the second clock-in was ignored.'); continue; }
      open = { recordId: e.recordId || e.id, clockInAt: at, clockOutAt: null, status: 'open', breaks: [], workedMinutes: 0, breakMinutes: 0, corrected: false, correctionCount: 0, flags: [...(e.flags ?? [])], inEventId: e.id, outEventId: null };
      openBreak = null; records.push(open); byId.set(open.recordId, open);
    } else if (e.type === 'clock_out') {
      if (!open) { note('clock_out_without_clock_in', e, 'A clock-out with no clock-in before it.'); continue; }
      if (openBreak) { openBreak.endAt = at; openBreak.minutes = mins(ms(openBreak.startAt), ms(at)); openBreak = null; }
      open.clockOutAt = at; open.status = 'closed'; open.outEventId = e.id; open = null;
    } else if (e.type === 'break_start') {
      if (!open) { note('break_without_clock_in', e, 'A break started while not clocked in.'); continue; }
      if (openBreak) { note('double_break_start', e, 'A break was started while on a break.'); continue; }
      openBreak = { startAt: at, endAt: null, minutes: 0 }; open.breaks.push(openBreak);
    } else if (e.type === 'break_end') {
      if (!open || !openBreak) { note('break_end_without_start', e, 'A break ended that never started.'); continue; }
      openBreak.endAt = at; openBreak.minutes = mins(ms(openBreak.startAt), ms(at)); openBreak = null;
    }
  }
  // corrections apply on top, oldest first (the latest value of a field wins); a correction can close an open record or void it
  for (const c of sorted.filter((x) => x.type === 'correction')) {
    const rec = c.recordId ? byId.get(c.recordId) : undefined;
    if (!rec || !c.correction) continue;
    rec.corrected = true; rec.correctionCount += 1;
    if (c.correction.voided) { rec.status = 'voided'; continue; }
    if (c.correction.clockInAt) rec.clockInAt = new Date(c.correction.clockInAt);
    if (c.correction.clockOutAt !== undefined) { rec.clockOutAt = c.correction.clockOutAt ? new Date(c.correction.clockOutAt) : null; rec.status = rec.clockOutAt ? 'closed' : 'open'; }
  }
  for (const rec of records) {
    for (const b of rec.breaks) if (!b.endAt && rec.clockOutAt) { b.endAt = rec.clockOutAt; b.minutes = mins(ms(b.startAt), ms(b.endAt)); }
    rec.breakMinutes = rec.breaks.reduce((n, b) => n + b.minutes, 0);
    const end = rec.clockOutAt ? ms(rec.clockOutAt) : null;
    rec.workedMinutes = end == null ? 0 : Math.max(0, mins(ms(rec.clockInAt), end) - rec.breakMinutes);
    if (rec.status === 'open' && now.getTime() - ms(rec.clockInAt) > MAX_OPEN_HOURS * 3_600_000) {
      rec.flags = [...new Set([...rec.flags, 'missing_clock_out'])];
      anomalies.push({ kind: 'missing_clock_out', recordId: rec.recordId, eventId: rec.inEventId, at: rec.clockInAt, detail: `Clocked in more than ${MAX_OPEN_HOURS} hours ago and never clocked out.` });
    }
    if (rec.clockOutAt && ms(rec.clockOutAt) < ms(rec.clockInAt)) anomalies.push({ kind: 'out_before_in', recordId: rec.recordId, eventId: rec.outEventId, at: rec.clockInAt, detail: 'The clock-out is before the clock-in.' });
  }
  // overlap between records (an offline sync that landed on top of another record)
  const live = records.filter((r) => r.status !== 'voided').sort((a, b) => ms(a.clockInAt) - ms(b.clockInAt));
  for (let i = 1; i < live.length; i++) {
    const prev = live[i - 1]; const cur = live[i];
    const prevEnd = prev.clockOutAt ? ms(prev.clockOutAt) : (now.getTime());
    if (ms(cur.clockInAt) < prevEnd && !(prev.status === 'open' && ms(cur.clockInAt) - ms(prev.clockInAt) > MAX_OPEN_HOURS * 3_600_000)) {
      anomalies.push({ kind: 'overlap', recordId: cur.recordId, eventId: cur.inEventId, at: cur.clockInAt, detail: 'This record overlaps another record of the same person.' });
      cur.flags = [...new Set([...cur.flags, 'overlap'])];
    }
  }
  return { records, anomalies };
}

/** The effective time of an event and the flags the server raises when it is written. `gap` = serverAt − deviceAt. */
export function effectiveTime(deviceAt: Date, serverAt: Date): { at: Date; flags: string[] } {
  const gap = serverAt.getTime() - deviceAt.getTime();
  const flags: string[] = [];
  if (gap < -CLOCK_SKEW_MS) { flags.push('device_clock_ahead'); return { at: serverAt, flags }; } // the device claims a time in the future: believe the server
  if (gap > LATE_SYNC_FLAG_MS) flags.push('late_sync');
  return { at: deviceAt, flags };
}

/** A live (online) event is validated strictly by the state machine; an event that reached the server late (offline queue) is recorded as it happened and checked afterwards. */
export const isLive = (deviceAt: Date, serverAt: Date): boolean => Math.abs(serverAt.getTime() - deviceAt.getTime()) <= 120_000;
