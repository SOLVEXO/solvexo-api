/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientSession, Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAction } from './pos-permissions.config';
import { localDay, localKey } from './pos-day.util';
import { AttEvent, LATE_GRACE_MINUTES, deriveRecords, effectiveTime, isLive } from './pos-attendance.util';

type Req = any;
interface Tokens { employee?: string; approver?: string }
const err = (status: 400 | 403 | 404 | 409, code: string, message: string, extra: object = {}) => {
  const body = { statusCode: status, code, message, ...extra };
  return status === 404 ? new NotFoundException(body) : status === 409 ? new ConflictException(body) : status === 403 ? new ForbiddenException(body) : new BadRequestException(body);
};
const str = (v: any, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const dateOf = (v: any, field: string, required = false): Date | null => {
  if (v === undefined || v === null || v === '') { if (required) throw err(400, 'INVALID_DATE', `${field} is required`); return null; }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw err(400, 'INVALID_DATE', `${field} is not a valid date`);
  return d;
};
const MAX_SHIFT_HOURS = 16;
const WEEK_WARN_MINUTES = 60 * 60;
const CLOCK_ACTIONS = ['clock_in', 'clock_out', 'break_start', 'break_end'] as const;

/**
 * G3.6 — team: attendance (clock in / out, breaks, by PIN), manager corrections, anomaly review, a weekly roster and the attendance report. No payroll.
 * Attendance is an append-only event log; "who is clocked in" is one conditional update on a state document, so one person can never have two open records.
 */
@Injectable()
export class PosTeamService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer) {}
  private get r(): any { return this.db.repositories; }

  private async gate(req: Req, storeId: string, action: PosAction, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    return this.auth.authorize(req, { storeId, action, employeeToken: t.employee, approverToken: t.approver });
  }
  private audit(storeId: string, employeeId: string | null, action: string, targetId: string | null, metadata: object, tx?: ClientSession) {
    return this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'team', metadata }], tx ? { session: tx } : undefined);
  }
  private deviceOf = (req: Req): string | null => req?.user?.posDevice?.deviceId ?? null;
  private atomic<T>(fn: (tx: ClientSession) => Promise<T>): Promise<T> { return this.r.posAttendanceStateModel.db.transaction(fn); }
  private async names(storeId: string, ids: string[]): Promise<Map<string, string>> {
    const valid = [...new Set(ids)].filter((i) => Types.ObjectId.isValid(i));
    const rows: any[] = valid.length ? await this.r.employeeModel.find({ _id: { $in: valid }, storeId }).select('name').lean() : [];
    return new Map(rows.map((e) => [String(e._id), e.name]));
  }
  private toEvent(e: any): AttEvent {
    return { id: String(e._id), type: e.type, at: e.at, serverAt: e.serverAt, recordId: e.recordId ?? null, flags: e.flags ?? [], correction: e.correction ?? null, reason: e.reason ?? null, employeeId: e.employeeId };
  }
  private recordView(rec: any, employeeId: string, name: string | null) {
    return { recordId: rec.recordId, employeeId, employeeName: name, clockInAt: rec.clockInAt, clockOutAt: rec.clockOutAt, status: rec.status, workedMinutes: rec.workedMinutes, breakMinutes: rec.breakMinutes, breaks: rec.breaks, corrected: rec.corrected, flags: rec.flags };
  }
  private selfId(a: { employeeId: string | null }): string {
    if (!a.employeeId) throw err(400, 'EMPLOYEE_REQUIRED', 'Sign in with your PIN — attendance belongs to a team member.');
    return a.employeeId;
  }

  // ── clocking ──────────────────────────────────────────────────────────────────
  private stateView(s: any) { return { clockedIn: !!s?.openRecordId, onBreak: !!s?.onBreak, since: s?.openSince ?? null, recordId: s?.openRecordId ?? null }; }

  /** The signed-in person: are they clocked in, and their next rostered shifts. */
  async me(req: Req, storeId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.attendance.own', t);
    const me = this.selfId(a);
    const st: any = await this.r.posAttendanceStateModel.findOne({ storeId, employeeId: me }).lean();
    const shifts: any[] = await this.r.posRosterShiftModel.find({ storeId, employeeId: me, status: 'active', endAt: { $gte: new Date() } }).sort({ startAt: 1 }).limit(7).lean();
    return { success: true, data: { employeeId: me, state: this.stateView(st), nextShifts: shifts.map((x) => this.shiftView(x)), serverTime: new Date() } };
  }

  /**
   * clock_in / clock_out / break_start / break_end for the PIN-signed-in person. `deviceAt` is the till's clock (an offline event keeps the time it really happened);
   * `requestId` makes a replay a no-op. A LIVE event (device and server agree) is checked strictly (409 ALREADY_CLOCKED_IN, NOT_CLOCKED_IN …); an event that reaches the server
   * late (the offline queue) is recorded as it happened and any inconsistency becomes an anomaly for a manager instead of a refusal — hours are never lost to a bad connection.
   */
  async clock(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.attendance.own', t);
    const me = this.selfId(a);
    const action = String(body?.action ?? '');
    if (!(CLOCK_ACTIONS as readonly string[]).includes(action)) throw err(400, 'INVALID_ACTION', 'action must be clock_in, clock_out, break_start or break_end');
    const requestId = str(body?.requestId, 100);
    if (!requestId) throw err(400, 'REQUEST_ID_REQUIRED', 'A clock event needs a requestId so a retry cannot count twice');
    const serverAt = new Date();
    const deviceAt = dateOf(body?.deviceAt, 'deviceAt') ?? serverAt;
    const dup: any = await this.r.posAttendanceEventModel.findOne({ storeId, requestId }).lean();
    const done = async (e: any, duplicate: boolean) => ({ success: true, data: { duplicate, event: { id: String(e._id), type: e.type, at: e.at, deviceAt: e.deviceAt, serverAt: e.serverAt, flags: e.flags }, state: this.stateView(await this.r.posAttendanceStateModel.findOne({ storeId, employeeId: me }).lean()) } });
    if (dup) return done(dup, true);
    const eff = effectiveTime(deviceAt, serverAt);
    const strict = isLive(deviceAt, serverAt);
    const S = this.r.posAttendanceStateModel;
    let ev: any;
    try {
      ev = await this.atomic(async (tx) => {
        let recordId: string | null = null; let extraBreakEnd = false;
        if (action === 'clock_in') {
          const cur = await S.findOne({ storeId, employeeId: me }).session(tx).lean();
          if (cur?.openRecordId) {
            if (strict) throw err(409, 'ALREADY_CLOCKED_IN', 'You are already clocked in.');
            recordId = cur.openRecordId; // a late event: recorded, flagged as a double clock-in by the derivation
          } else {
            const newId = String(new Types.ObjectId());
            await S.updateOne({ storeId, employeeId: me }, { $set: { openRecordId: newId, onBreak: false, openSince: eff.at } }, { upsert: true, session: tx });
            recordId = newId;
          }
        } else if (action === 'clock_out') {
          const before = await S.findOneAndUpdate({ storeId, employeeId: me, openRecordId: { $ne: null } }, { $set: { openRecordId: null, onBreak: false, openSince: null } }, { new: false, session: tx });
          if (!before) { if (strict) throw err(409, 'NOT_CLOCKED_IN', 'You are not clocked in.'); }
          else { recordId = before.openRecordId; extraBreakEnd = !!before.onBreak; }
        } else {
          const want = action === 'break_start';
          const before = await S.findOneAndUpdate({ storeId, employeeId: me, openRecordId: { $ne: null }, onBreak: !want }, { $set: { onBreak: want } }, { new: false, session: tx });
          if (!before) {
            if (strict) { const cur = await S.findOne({ storeId, employeeId: me }).session(tx).lean(); throw err(409, !cur?.openRecordId ? 'NOT_CLOCKED_IN' : want ? 'ALREADY_ON_BREAK' : 'NOT_ON_BREAK', !cur?.openRecordId ? 'You are not clocked in.' : want ? 'You are already on a break.' : 'You are not on a break.'); }
          } else recordId = before.openRecordId;
        }
        const base = { storeId, employeeId: me, recordId, deviceAt, serverAt, at: eff.at, actorId: me, deviceId: this.deviceOf(req), registerId: str(body?.registerId, 40), locationId: str(body?.locationId, 40), reason: str(body?.note, 200) };
        const [e] = await this.r.posAttendanceEventModel.create([{ ...base, type: action, flags: eff.flags, requestId }], { session: tx });
        if (extraBreakEnd) await this.r.posAttendanceEventModel.create([{ ...base, type: 'break_end', flags: [], requestId: `${requestId}:be` }], { session: tx });
        return e;
      });
    } catch (e: any) {
      if (e?.code === 11000) {
        const d2: any = await this.r.posAttendanceEventModel.findOne({ storeId, requestId }).lean(); if (d2) return done(d2, true);
        if (action === 'clock_in') throw err(409, 'ALREADY_CLOCKED_IN', 'You are already clocked in.'); // two first-ever clock-ins raced on the state document
      }
      throw e;
    }
    return done(ev.toObject(), false);
  }

  // ── reading + review ──────────────────────────────────────────────────────────
  private async eventsOf(storeId: string, from: Date, to: Date, employeeId?: string): Promise<Map<string, AttEvent[]>> {
    const filter: any = { storeId, at: { $gte: new Date(from.getTime() - 2 * 86_400_000), $lt: new Date(to.getTime() + 86_400_000) } };
    if (employeeId) filter.employeeId = employeeId;
    const rows: any[] = await this.r.posAttendanceEventModel.find(filter).sort({ at: 1 }).lean();
    const by = new Map<string, AttEvent[]>();
    for (const e of rows) { const l = by.get(e.employeeId) ?? []; l.push(this.toEvent(e)); by.set(e.employeeId, l); }
    return by;
  }
  private scope(a: { role: string; employeeId: string | null }, q: any): string | undefined {
    if (a.role === 'cashier') {
      if (q?.employeeId && String(q.employeeId) !== a.employeeId) throw err(403, 'POS_ACTION_FORBIDDEN', 'You can only see your own attendance');
      return this.selfId(a);
    }
    return q?.employeeId ? String(q.employeeId) : undefined;
  }

  async records(req: Req, storeId: string, q: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.attendance.own', t);
    const from = dateOf(q?.from, 'from', true)!; const to = dateOf(q?.to, 'to', true)!;
    const emp = this.scope(a, q);
    const by = await this.eventsOf(storeId, from, to, emp);
    const names = await this.names(storeId, [...by.keys()]);
    const out: any[] = [];
    for (const [id, evs] of by) for (const rec of deriveRecords(evs).records) if (rec.clockInAt >= from && rec.clockInAt < to) out.push(this.recordView(rec, id, names.get(id) ?? null));
    out.sort((x, y) => new Date(y.clockInAt).getTime() - new Date(x.clockInAt).getTime());
    return { success: true, data: { records: out } };
  }

  /** One record with its raw punches and its correction history (who changed what, why) — the audit trail behind the derived hours. A cashier only their own. */
  async recordDetail(req: Req, storeId: string, employeeId: string, recordId: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.attendance.own', t);
    this.scope(a, { employeeId });
    const now = new Date();
    const rows: any[] = await this.r.posAttendanceEventModel.find({ storeId, employeeId, at: { $gte: new Date(now.getTime() - 120 * 86_400_000) } }).sort({ at: 1, _id: 1 }).lean();
    const rec = deriveRecords(rows.map((e) => this.toEvent(e)), now).records.find((x) => x.recordId === recordId);
    if (!rec) throw err(404, 'RECORD_NOT_FOUND', 'Attendance record not found');
    const mine = rows.filter((e) => e.recordId === recordId);
    const names = await this.names(storeId, [employeeId, ...mine.map((e) => e.actorId).filter(Boolean)]);
    return { success: true, data: {
      record: this.recordView(rec, employeeId, names.get(employeeId) ?? null),
      punches: mine.filter((e) => e.type !== 'correction').map((e) => ({ id: String(e._id), type: e.type, at: e.at, deviceAt: e.deviceAt, serverAt: e.serverAt, flags: e.flags ?? [], deviceId: e.deviceId ?? null })),
      corrections: mine.filter((e) => e.type === 'correction').map((e) => ({ id: String(e._id), at: e.serverAt, reason: e.reason ?? null, byId: e.actorId ?? null, byName: names.get(e.actorId) ?? null, clockInAt: e.correction?.clockInAt ?? null, clockOutAt: e.correction?.clockOutAt ?? null, voided: e.correction?.voided === true })),
    } };
  }

  /** What needs a manager: missing clock-outs, overlaps, double clock-ins, device-clock gaps, late syncs — except what was already acknowledged. */
  async anomalies(req: Req, storeId: string, t: Tokens) {
    await this.gate(req, storeId, 'team.attendance.view', t);
    const to = new Date(); const from = new Date(to.getTime() - 14 * 86_400_000);
    const by = await this.eventsOf(storeId, from, to);
    const acked: any[] = await this.r.posAttendanceEventModel.find({ storeId, type: 'ack', at: { $gte: from } }).select('targetEventId reason').lean();
    const ackSet = new Set(acked.map((x) => `${x.reason}:${x.targetEventId}`));
    const names = await this.names(storeId, [...by.keys()]);
    const list: any[] = [];
    for (const [id, evs] of by) for (const an of deriveRecords(evs, to).anomalies) {
      if (an.at < from || ackSet.has(`${an.kind}:${an.eventId}`)) continue;
      list.push({ employeeId: id, employeeName: names.get(id) ?? null, kind: an.kind, recordId: an.recordId, eventId: an.eventId, at: an.at, detail: an.detail });
    }
    list.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
    return { success: true, data: { anomalies: list } };
  }
  async ack(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.attendance.edit', t);
    const employeeId = str(body?.employeeId, 40); const eventId = str(body?.eventId, 40); const kind = str(body?.kind, 60);
    if (!employeeId || !eventId || !kind) throw err(400, 'INVALID_ACK', 'employeeId, eventId and kind are required');
    const now = new Date();
    await this.r.posAttendanceEventModel.create([{ storeId, employeeId, type: 'ack', targetEventId: eventId, reason: kind, deviceAt: now, serverAt: now, at: now, actorId: a.employeeId, deviceId: this.deviceOf(req), requestId: str(body?.requestId, 100) }]);
    await this.audit(storeId, a.employeeId, 'attendance_anomaly_acknowledged', eventId, { employeeId, kind, note: str(body?.note, 300) });
    return { success: true, data: { acknowledged: true } };
  }

  /** A manager's fix = a NEW correction row on a record (set the times, add a missing clock-out, or void it). The raw events stay; the reason is required; audited. */
  async correct(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.attendance.edit', t);
    const employeeId = str(body?.employeeId, 40); const recordId = str(body?.recordId, 40);
    const reason = str(body?.reason, 300);
    if (!employeeId || !recordId) throw err(400, 'INVALID_CORRECTION', 'employeeId and recordId are required');
    if (!reason) throw err(400, 'REASON_REQUIRED', 'Say why the attendance is being corrected');
    const clockInAt = dateOf(body?.clockInAt, 'clockInAt'); const clockOutAt = dateOf(body?.clockOutAt, 'clockOutAt'); const voided = body?.voided === true;
    if (!voided && !clockInAt && !clockOutAt) throw err(400, 'INVALID_CORRECTION', 'Nothing to change');
    const now = new Date();
    if ((clockInAt && clockInAt.getTime() > now.getTime() + 300_000) || (clockOutAt && clockOutAt.getTime() > now.getTime() + 300_000)) throw err(400, 'INVALID_DATE', 'A corrected time cannot be in the future');
    const evs = (await this.eventsOf(storeId, new Date(now.getTime() - 60 * 86_400_000), now, employeeId)).get(employeeId) ?? [];
    const before = deriveRecords(evs, now).records.find((x) => x.recordId === recordId);
    if (!before) throw err(404, 'RECORD_NOT_FOUND', 'Attendance record not found');
    const newIn = clockInAt ?? before.clockInAt; const newOut = clockOutAt ?? before.clockOutAt;
    if (!voided && newOut && newOut.getTime() <= newIn.getTime()) throw err(400, 'INVALID_DATE', 'The clock-out must be after the clock-in');
    await this.atomic(async (tx) => {
      await this.r.posAttendanceEventModel.create([{
        storeId, employeeId, type: 'correction', recordId, deviceAt: now, serverAt: now, at: now, reason, actorId: a.employeeId, deviceId: this.deviceOf(req), requestId: str(body?.requestId, 100),
        correction: { ...(clockInAt ? { clockInAt } : {}), ...(clockOutAt ? { clockOutAt } : {}), ...(voided ? { voided: true } : {}) },
      }], { session: tx });
      // closing (or voiding) the record that is open right now also frees the person to clock in again
      if ((clockOutAt || voided) && before.status === 'open') await this.r.posAttendanceStateModel.updateOne({ storeId, employeeId, openRecordId: recordId }, { $set: { openRecordId: null, onBreak: false, openSince: null } }, { session: tx });
      await this.audit(storeId, a.employeeId, 'attendance_corrected', recordId, { employeeId, reason, before: { clockInAt: before.clockInAt, clockOutAt: before.clockOutAt, status: before.status }, after: voided ? { voided: true } : { clockInAt: newIn, clockOutAt: newOut } }, tx);
    });
    const after = deriveRecords((await this.eventsOf(storeId, new Date(now.getTime() - 60 * 86_400_000), now, employeeId)).get(employeeId) ?? [], now).records.find((x) => x.recordId === recordId)!;
    return { success: true, data: { record: this.recordView(after, employeeId, (await this.names(storeId, [employeeId])).get(employeeId) ?? null) } };
  }

  // ── roster ────────────────────────────────────────────────────────────────────
  private shiftView(x: any, names?: Map<string, string>, warnings: string[] = []) {
    return { id: String(x._id), employeeId: x.employeeId, employeeName: names?.get(x.employeeId) ?? null, locationId: x.locationId ?? null, startAt: x.startAt, endAt: x.endAt, note: x.note ?? null, status: x.status, ...(warnings.length ? { warnings } : {}) };
  }
  async rosterList(req: Req, storeId: string, q: any, t: Tokens) {
    await this.gate(req, storeId, 'team.roster.view', t);
    const from = dateOf(q?.from, 'from', true)!; const to = dateOf(q?.to, 'to', true)!;
    const filter: any = { storeId, status: 'active', startAt: { $gte: from, $lt: to } };
    if (q?.employeeId) filter.employeeId = String(q.employeeId);
    const rows: any[] = await this.r.posRosterShiftModel.find(filter).sort({ startAt: 1 }).lean();
    const names = await this.names(storeId, rows.map((x) => x.employeeId));
    return { success: true, data: { shifts: rows.map((x) => this.shiftView(x, names)) } };
  }
  private async checkShift(storeId: string, body: any, selfId?: string) {
    const employeeId = str(body?.employeeId, 40);
    const startAt = dateOf(body?.startAt, 'startAt', true)!; const endAt = dateOf(body?.endAt, 'endAt', true)!;
    if (!employeeId || !Types.ObjectId.isValid(employeeId)) throw err(400, 'EMPLOYEE_REQUIRED', 'Choose the team member');
    const emp = await this.r.employeeModel.findOne({ _id: employeeId, storeId, isDelete: { $ne: true } }).select('_id').lean();
    if (!emp) throw err(404, 'EMPLOYEE_NOT_FOUND', 'Team member not found');
    if (endAt <= startAt) throw err(400, 'INVALID_RANGE', 'The shift must end after it starts');
    if ((endAt.getTime() - startAt.getTime()) > MAX_SHIFT_HOURS * 3_600_000) throw err(400, 'SHIFT_TOO_LONG', `A shift can be at most ${MAX_SHIFT_HOURS} hours`);
    const locationId = str(body?.locationId, 40);
    if (locationId) { const loc = await this.r.storeLocationModel.findOne({ _id: locationId, storeId, isDelete: false }).select('_id').lean(); if (!loc) throw err(404, 'LOCATION_NOT_FOUND', 'Location not found'); }
    const clash: any = await this.r.posRosterShiftModel.findOne({ storeId, employeeId, status: 'active', startAt: { $lt: endAt }, endAt: { $gt: startAt }, ...(selfId ? { _id: { $ne: selfId } } : {}) }).lean();
    if (clash) throw err(409, 'ROSTER_OVERLAP', 'This person already has a shift at that time.', { conflictWith: String(clash._id), conflictStartAt: clash.startAt, conflictEndAt: clash.endAt });
    // a long week is a warning, not a block
    const zone = await this.pos.storeTz(storeId); const day0 = localDay(startAt, zone); const dow = (new Date(`${day0.key}T12:00:00Z`).getUTCDay() + 6) % 7;
    const weekStart = localDay(new Date(day0.start.getTime() - dow * 86_400_000 + 12 * 3_600_000), zone).start; const weekEnd = localDay(new Date(weekStart.getTime() + 7 * 86_400_000 + 12 * 3_600_000), zone).start; // Monday 00:00 → next Monday, local
    const week: any[] = await this.r.posRosterShiftModel.find({ storeId, employeeId, status: 'active', startAt: { $gte: weekStart, $lt: weekEnd }, ...(selfId ? { _id: { $ne: selfId } } : {}) }).select('startAt endAt').lean();
    const total = week.reduce((n, x) => n + (x.endAt.getTime() - x.startAt.getTime()) / 60_000, 0) + (endAt.getTime() - startAt.getTime()) / 60_000;
    return { employeeId, startAt, endAt, locationId, note: str(body?.note, 200), warnings: total > WEEK_WARN_MINUTES ? ['OVER_60_HOURS_WEEK'] : [] };
  }
  async rosterCreate(req: Req, storeId: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.roster.edit', t);
    const c = await this.checkShift(storeId, body);
    const doc = await this.r.posRosterShiftModel.create({ storeId, employeeId: c.employeeId, locationId: c.locationId, startAt: c.startAt, endAt: c.endAt, note: c.note, createdBy: a.employeeId ?? 'owner' });
    await this.audit(storeId, a.employeeId, 'roster_shift_created', String(doc._id), { employeeId: c.employeeId, startAt: c.startAt, endAt: c.endAt });
    return { success: true, data: { shift: this.shiftView(doc.toObject(), await this.names(storeId, [c.employeeId]), c.warnings) } };
  }
  async rosterUpdate(req: Req, storeId: string, id: string, body: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.roster.edit', t);
    const cur: any = Types.ObjectId.isValid(id) ? await this.r.posRosterShiftModel.findOne({ _id: id, storeId, status: 'active' }).lean() : null;
    if (!cur) throw err(404, 'SHIFT_NOT_FOUND', 'Shift not found');
    const c = await this.checkShift(storeId, { employeeId: cur.employeeId, startAt: cur.startAt, endAt: cur.endAt, locationId: cur.locationId, note: cur.note, ...body }, id);
    const doc: any = await this.r.posRosterShiftModel.findOneAndUpdate({ _id: id, storeId }, { $set: { employeeId: c.employeeId, locationId: c.locationId, startAt: c.startAt, endAt: c.endAt, note: c.note } }, { new: true }).lean();
    await this.audit(storeId, a.employeeId, 'roster_shift_updated', id, { before: { startAt: cur.startAt, endAt: cur.endAt, employeeId: cur.employeeId }, after: { startAt: c.startAt, endAt: c.endAt, employeeId: c.employeeId } });
    return { success: true, data: { shift: this.shiftView(doc, await this.names(storeId, [c.employeeId]), c.warnings) } };
  }
  async rosterCancel(req: Req, storeId: string, id: string, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.roster.edit', t);
    const hit = Types.ObjectId.isValid(id) ? await this.r.posRosterShiftModel.findOneAndUpdate({ _id: id, storeId, status: 'active' }, { $set: { status: 'cancelled' } }) : null;
    if (!hit) throw err(404, 'SHIFT_NOT_FOUND', 'Shift not found');
    await this.audit(storeId, a.employeeId, 'roster_shift_cancelled', id, { employeeId: hit.employeeId, startAt: hit.startAt });
    return { success: true, data: { cancelled: true } };
  }

  // ── report ────────────────────────────────────────────────────────────────────
  /** Per person and period: hours worked, days, breaks, late arrivals (vs the rostered start, with a grace), missing clock-outs, corrections. No payroll, no money. */
  async report(req: Req, storeId: string, q: any, t: Tokens) {
    const a = await this.gate(req, storeId, 'team.attendance.own', t);
    const from = dateOf(q?.from, 'from', true)!; const to = dateOf(q?.to, 'to', true)!;
    if (to <= from || to.getTime() - from.getTime() > 93 * 86_400_000) throw err(400, 'RANGE_REQUIRED', 'Send a period of at most 93 days');
    const zone = await this.pos.storeTz(storeId); // G4.0: days are the STORE's days (the old tzOffsetMinutes parameter is ignored)
    const emp = this.scope(a, q);
    const by = await this.eventsOf(storeId, from, to, emp);
    const shiftFilter: any = { storeId, status: 'active', startAt: { $gte: new Date(from.getTime() - 86_400_000), $lt: new Date(to.getTime() + 86_400_000) } };
    if (emp) shiftFilter.employeeId = emp;
    const roster: any[] = await this.r.posRosterShiftModel.find(shiftFilter).lean();
    const ids = [...new Set([...by.keys(), ...roster.map((x) => x.employeeId)])];
    const names = await this.names(storeId, ids);
    const now = new Date();
    const people = ids.map((id) => {
      const recs = deriveRecords(by.get(id) ?? [], now).records.filter((x) => x.status !== 'voided' && x.clockInAt >= from && x.clockInAt < to);
      const mine = roster.filter((x) => x.employeeId === id);
      let lateCount = 0; let lateMinutes = 0;
      for (const rec of recs) {
        const sh = mine.filter((x) => Math.abs(x.startAt.getTime() - rec.clockInAt.getTime()) <= 6 * 3_600_000).sort((x, y) => Math.abs(x.startAt.getTime() - rec.clockInAt.getTime()) - Math.abs(y.startAt.getTime() - rec.clockInAt.getTime()))[0];
        if (!sh) continue;
        const late = Math.round((rec.clockInAt.getTime() - sh.startAt.getTime()) / 60_000);
        if (late > LATE_GRACE_MINUTES) { lateCount++; lateMinutes += late; }
      }
      const days = new Set(recs.map((x) => localKey(x.clockInAt, zone)));
      return {
        employeeId: id, employeeName: names.get(id) ?? null, daysWorked: days.size, records: recs.length, workedMinutes: recs.reduce((n, x) => n + x.workedMinutes, 0), breakMinutes: recs.reduce((n, x) => n + x.breakMinutes, 0),
        lateCount, lateMinutes, missingClockOuts: recs.filter((x) => x.flags.includes('missing_clock_out')).length, corrections: recs.filter((x) => x.corrected).length,
        rosteredMinutes: mine.filter((x) => x.startAt >= from && x.startAt < to).reduce((n, x) => n + Math.round((x.endAt.getTime() - x.startAt.getTime()) / 60_000), 0),
      };
    }).sort((x, y) => (x.employeeName ?? '').localeCompare(y.employeeName ?? ''));
    return { success: true, data: { from, to, timeZone: zone, lateGraceMinutes: LATE_GRACE_MINUTES, people, totals: { workedMinutes: people.reduce((n, x) => n + x.workedMinutes, 0), lateCount: people.reduce((n, x) => n + x.lateCount, 0), missingClockOuts: people.reduce((n, x) => n + x.missingClockOuts, 0) } } };
  }
}
