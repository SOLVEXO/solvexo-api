/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosTeamService } from './pos-team.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G3.6 on a real replica-set MongoDB: attendance by PIN, one open record per person (races), offline events, anomalies, corrections, roster, report. */
jest.setTimeout(300_000);
let h: MongoHarness; let team: PosTeamService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, {
    posAttendanceEventModel: h.conn.model(schema.PosAttendanceEvent.name, schema.PosAttendanceEventSchema),
    posAttendanceStateModel: h.conn.model(schema.PosAttendanceState.name, schema.PosAttendanceStateSchema),
    posRosterShiftModel: h.conn.model(schema.PosRosterShift.name, schema.PosRosterShiftSchema),
  });
  r = h.repos;
  await Promise.all(['posAttendanceEventModel', 'posAttendanceStateModel', 'posRosterShiftModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  const pos = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  team = new PosTeamService(dbs, pos, new PosAuthorizer(dbs, pos));
});
afterAll(async () => { await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const rid = () => String(new Types.ObjectId());
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function world() {
  const s = await seedStore(h, { stock: 1 });
  const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
  const clock = (action: string, who: any = C, extra: any = {}) => team.clock(device(s), s.storeId, { action, requestId: rid(), ...extra }, who);
  const state = async (who: any = C) => (await team.me(device(s), s.storeId, who)).data.state;
  const day = { from: new Date(Date.now() - 2 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
  const records = async (who: any = M, q: any = {}) => (await team.records(device(s), s.storeId, { ...day, ...q }, who)).data.records;
  return { s, M, C, clock, state, day, records };
}

describe('clocking with the staff PIN', () => {
  it('clock in → break → break end → clock out: state follows, both device time and server time are stored, hours add up', async () => {
    const w = await world();
    expect((await w.state()).clockedIn).toBe(false);
    const a = (await w.clock('clock_in')).data;
    expect([a.state.clockedIn, a.duplicate, a.event.flags]).toEqual([true, false, []]);
    const row: any = await r.posAttendanceEventModel.findOne({ storeId: w.s.storeId, type: 'clock_in' }).lean();
    expect([row.employeeId, !!row.deviceAt, !!row.serverAt, !!row.at]).toEqual([w.s.cashierId, true, true, true]);
    expect((await w.clock('break_start')).data.state.onBreak).toBe(true);
    expect((await w.clock('break_end')).data.state.onBreak).toBe(false);
    const out = (await w.clock('clock_out')).data;
    expect(out.state).toMatchObject({ clockedIn: false, onBreak: false });
    const recs = await w.records();
    expect(recs).toHaveLength(1);
    expect([recs[0].status, recs[0].employeeName, recs[0].breaks.length]).toEqual(['closed', 'Cal Cashier', 1]);
  });

  it('strict when live: a second clock-in, a clock-out / break while not clocked in, a break twice — each refused with its own code', async () => {
    const w = await world();
    expect(await code(w.clock('clock_out'))).toBe('NOT_CLOCKED_IN');
    expect(await code(w.clock('break_start'))).toBe('NOT_CLOCKED_IN');
    await w.clock('clock_in');
    expect(await code(w.clock('clock_in'))).toBe('ALREADY_CLOCKED_IN');
    expect(await code(w.clock('break_end'))).toBe('NOT_ON_BREAK');
    await w.clock('break_start');
    expect(await code(w.clock('break_start'))).toBe('ALREADY_ON_BREAK');
    await w.clock('clock_out'); // a clock-out during a break ends the break too
    const evs: any[] = await r.posAttendanceEventModel.find({ storeId: w.s.storeId, employeeId: w.s.cashierId }).sort({ serverAt: 1, _id: 1 }).lean();
    expect(evs.map((e) => e.type)).toEqual(['clock_in', 'break_start', 'clock_out', 'break_end']);
    expect(await code(w.clock('lunch'))).toBe('INVALID_ACTION');
    expect(await code(team.clock(device(w.s), w.s.storeId, { action: 'clock_in' }, w.C))).toBe('REQUEST_ID_REQUIRED');
    expect(await code(team.clock(owner(w.s), w.s.storeId, { action: 'clock_in', requestId: rid() }, {}))).toBe('EMPLOYEE_REQUIRED'); // the owner login is nobody on the roster
  });

  it('one open record per person even when two tills clock the same person in at the same moment', async () => {
    for (let i = 0; i < 6; i++) {
      const w = await world();
      const res = await Promise.allSettled([w.clock('clock_in'), w.clock('clock_in'), w.clock('clock_in')]);
      expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      for (const x of res) if (x.status === 'rejected') expect((x.reason as any)?.response?.code).toBe('ALREADY_CLOCKED_IN');
      expect(await r.posAttendanceEventModel.countDocuments({ storeId: w.s.storeId, type: 'clock_in' })).toBe(1);
      expect(await r.posAttendanceStateModel.countDocuments({ storeId: w.s.storeId, employeeId: w.s.cashierId })).toBe(1);
    }
  });

  it('a replay (retry / offline queue twice) counts once; a device clock AHEAD of the server uses the server time and is flagged', async () => {
    const w = await world();
    const id = rid();
    const a = (await w.clock('clock_in', w.C, { requestId: id })).data;
    const b = (await w.clock('clock_in', w.C, { requestId: id })).data;
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(await r.posAttendanceEventModel.countDocuments({ storeId: w.s.storeId })).toBe(1);
    const w2 = await world();
    const ahead = new Date(Date.now() + 40 * 60_000).toISOString();
    const e = (await w2.clock('clock_in', w2.C, { deviceAt: ahead })).data.event;
    expect(e.flags).toEqual(['device_clock_ahead']);
    expect(new Date(e.at).getTime()).toBeLessThan(Date.now() + 5_000); // the server's time counts
    expect(new Date(e.deviceAt).toISOString()).toBe(ahead); // …and the device's is kept
    expect(await code(w2.clock('clock_out', w2.C, { deviceAt: 'not a date' }))).toBe('INVALID_DATE');
  });
});

describe('offline clock events and anomalies', () => {
  it('a queued in / break / out synced hours later keeps its own times and order; hours are exact', async () => {
    const w = await world();
    await w.clock('clock_in', w.C, { deviceAt: ago(8 * 60) });
    await w.clock('break_start', w.C, { deviceAt: ago(5 * 60) });
    await w.clock('break_end', w.C, { deviceAt: ago(4.5 * 60) });
    const out = (await w.clock('clock_out', w.C, { deviceAt: ago(60) })).data;
    expect(out.state.clockedIn).toBe(false);
    const rec = (await w.records())[0];
    expect([rec.status, rec.workedMinutes, rec.breakMinutes]).toEqual(['closed', 7 * 60 - 30, 30]);
  });

  it('a late event that does not fit is RECORDED (hours are never lost) and shows up as an anomaly for a manager; a manager acknowledges it; a cashier cannot see anomalies', async () => {
    const w = await world();
    await w.clock('clock_in', w.C, { deviceAt: ago(10 * 60) });
    await w.clock('clock_in', w.C, { deviceAt: ago(9 * 60) });  // a second tablet replays a clock-in: not refused (it is late), flagged
    await w.clock('clock_out', w.C, { deviceAt: ago(2 * 60) });
    await w.clock('clock_out', w.C, { deviceAt: ago(60) });     // a clock-out with nothing open
    const list = (await team.anomalies(device(w.s), w.s.storeId, w.M)).data.anomalies;
    expect(list.map((x: any) => x.kind).sort()).toEqual(['clock_out_without_clock_in', 'double_clock_in']);
    expect(list[0].employeeName).toBe('Cal Cashier');
    expect(await code(team.anomalies(device(w.s), w.s.storeId, w.C))).toBe('POS_ACTION_FORBIDDEN');
    await team.ack(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, eventId: list[0].eventId, kind: list[0].kind, note: 'checked' }, w.M);
    expect((await team.anomalies(device(w.s), w.s.storeId, w.M)).data.anomalies).toHaveLength(1);
    expect(await code(team.ack(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, eventId: 'x', kind: 'y' }, w.C))).toBe('POS_ACTION_FORBIDDEN');
  });

  it('a missing clock-out (open for more than 14 hours) is flagged; a very old offline event is flagged "late_sync"', async () => {
    const w = await world();
    await w.clock('clock_in', w.C, { deviceAt: ago(20 * 60) });
    const kinds = (await team.anomalies(device(w.s), w.s.storeId, w.M)).data.anomalies.map((x: any) => x.kind).sort();
    expect(kinds).toEqual(['late_sync', 'missing_clock_out']);
  });
});

describe('corrections (never overwrite) + audit', () => {
  it('a manager adds the missing clock-out as a NEW row: the record closes, the person can clock in again, the raw events are untouched, a reason is required, a cashier cannot', async () => {
    const w = await world();
    await w.clock('clock_in', w.C, { deviceAt: ago(20 * 60) });
    const rec = (await w.records())[0];
    const before = await r.posAttendanceEventModel.countDocuments({ storeId: w.s.storeId });
    expect(await code(team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: rec.recordId, clockOutAt: ago(12 * 60) }, w.M))).toBe('REASON_REQUIRED');
    expect(await code(team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: rec.recordId, clockOutAt: ago(12 * 60), reason: 'x' }, w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: rec.recordId, clockOutAt: ago(21 * 60), reason: 'x' }, w.M))).toBe('INVALID_DATE'); // before the clock-in
    const fixed = (await team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: rec.recordId, clockOutAt: ago(12 * 60), reason: 'forgot to clock out' }, w.M)).data.record;
    expect([fixed.status, fixed.workedMinutes, fixed.corrected]).toEqual(['closed', 8 * 60, true]);
    expect(await r.posAttendanceEventModel.countDocuments({ storeId: w.s.storeId })).toBe(before + 1); // one new row, nothing edited
    const raw: any = await r.posAttendanceEventModel.findOne({ storeId: w.s.storeId, type: 'clock_in' }).lean();
    expect(raw.at).toBeTruthy();
    await expect(r.posAttendanceEventModel.updateOne({ _id: raw._id }, { $set: { at: new Date() } })).rejects.toThrow(/append-only/);
    expect((await w.state()).clockedIn).toBe(false);
    expect((await w.clock('clock_in')).data.state.clockedIn).toBe(true); // free to clock in again
    const audit: any = await r.posAuditLogModel.findOne({ storeId: w.s.storeId, action: 'attendance_corrected' }).lean();
    expect([audit.employeeId, audit.metadata.reason, audit.metadata.before.status, audit.metadata.after.clockOutAt != null]).toEqual([w.s.managerId, 'forgot to clock out', 'open', true]);
    expect((await team.anomalies(device(w.s), w.s.storeId, w.M)).data.anomalies.map((x: any) => x.kind)).not.toContain('missing_clock_out');
    // the audit trail behind the hours: raw punches (device + server time) and who corrected what, why
    const d = (await team.recordDetail(device(w.s), w.s.storeId, w.s.cashierId, rec.recordId, w.C)).data; // the person themself may read it
    expect(d.punches.map((x: any) => x.type)).toEqual(['clock_in']);
    expect(d.corrections).toHaveLength(1);
    expect([d.corrections[0].reason, d.corrections[0].byName, d.corrections[0].clockOutAt != null, d.record.corrected]).toEqual(['forgot to clock out', 'Mia Manager', true, true]);
    expect(await code(team.recordDetail(device(w.s), w.s.storeId, w.s.managerId, rec.recordId, w.C))).toBe('POS_ACTION_FORBIDDEN'); // not someone else's
    expect(await code(team.recordDetail(device(w.s), w.s.storeId, w.s.cashierId, 'nope', w.M))).toBe('RECORD_NOT_FOUND');
  });

  it('set the times on a closed record, then void it: the hours follow, each is a new row', async () => {
    const w = await world();
    await w.clock('clock_in', w.C, { deviceAt: ago(600) }); await w.clock('clock_out', w.C, { deviceAt: ago(120) });
    const rec = (await w.records())[0];
    expect(rec.workedMinutes).toBe(480);
    const moved = (await team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: rec.recordId, clockInAt: ago(540), reason: 'arrived later' }, w.M)).data.record;
    expect(moved.workedMinutes).toBe(420);
    const gone = (await team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: rec.recordId, voided: true, reason: 'duplicate' }, w.M)).data.record;
    expect(gone.status).toBe('voided');
    expect(await code(team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: 'nope', voided: true, reason: 'x' }, w.M))).toBe('RECORD_NOT_FOUND');
  });
});

describe('roster', () => {
  const at = (dayOffset: number, hour: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + dayOffset); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
  it('a manager plans weekly shifts: overlap refused, a day longer than 16 h refused, a 60 h week warned (not blocked); a cashier may read but not edit; the person sees their own on Home', async () => {
    const w = await world();
    const mk = (b: any, who: any = w.M) => team.rosterCreate(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, ...b }, who);
    const a = (await mk({ startAt: at(1, 9), endAt: at(1, 17), note: 'opening' })).data.shift;
    expect([a.employeeName, a.status]).toEqual(['Cal Cashier', 'active']);
    expect(await code(mk({ startAt: at(1, 16), endAt: at(1, 20) }))).toBe('ROSTER_OVERLAP');
    expect((await mk({ startAt: at(1, 17), endAt: at(1, 20) })).success).toBe(true); // back to back is fine
    expect(await code(mk({ startAt: at(2, 6), endAt: at(2, 23) }))).toBe('SHIFT_TOO_LONG');
    expect(await code(mk({ startAt: at(3, 10), endAt: at(3, 9) }))).toBe('INVALID_RANGE');
    expect(await code(mk({ employeeId: oidOf(), startAt: at(3, 9), endAt: at(3, 10) }))).toBe('EMPLOYEE_NOT_FOUND');
    expect(await code(mk({ startAt: at(2, 9), endAt: at(2, 17) }, w.C))).toBe('POS_ACTION_FORBIDDEN');
    // a long week warns
    let warned = false;
    for (let d = 2; d <= 8 && !warned; d++) { const out: any = await mk({ startAt: at(d, 0), endAt: at(d, 16) }); warned = (out.data.shift.warnings ?? []).includes('OVER_60_HOURS_WEEK'); }
    expect(warned).toBe(true);
    const list = (await team.rosterList(device(w.s), w.s.storeId, { from: at(0, 0), to: at(12, 0) }, w.C)).data.shifts; // a cashier can read it
    expect(list.length).toBeGreaterThan(3);
    const mine = (await team.me(device(w.s), w.s.storeId, w.C)).data.nextShifts;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x: any) => x.employeeId === w.s.cashierId)).toBe(true);
    expect((await team.me(device(w.s), w.s.storeId, w.M)).data.nextShifts).toEqual([]); // the manager has none
    // update (re-checked for conflicts) and cancel
    const upd = (await team.rosterUpdate(device(w.s), w.s.storeId, a.id, { endAt: at(1, 16) }, w.M)).data.shift;
    expect(new Date(upd.endAt).toISOString()).toBe(at(1, 16));
    await team.rosterCancel(device(w.s), w.s.storeId, a.id, w.M);
    expect(await code(team.rosterUpdate(device(w.s), w.s.storeId, a.id, { endAt: at(1, 15) }, w.M))).toBe('SHIFT_NOT_FOUND');
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: { $in: ['roster_shift_created', 'roster_shift_updated', 'roster_shift_cancelled'] } })).toBeGreaterThan(3);
  });
});
const oidOf = () => String(new Types.ObjectId());

describe('attendance report', () => {
  it('hours, days, breaks, late arrivals against the roster (with a 10-minute grace), missing clock-outs, corrections; a cashier sees only themself', async () => {
    const w = await world();
    const d = (daysAgo: number, hh: number, mm = 0) => { const x = new Date(); x.setUTCDate(x.getUTCDate() - daysAgo); x.setUTCHours(hh, mm, 0, 0); return x; };
    const shift = (daysAgo: number, from: number, to: number) => r.posRosterShiftModel.create({ storeId: w.s.storeId, employeeId: w.s.cashierId, startAt: d(daysAgo, from), endAt: d(daysAgo, to) });
    await shift(5, 9, 17); await shift(4, 9, 17); await shift(3, 9, 17);
    const ev = (type: string, at: Date, recordId: string | null, extra: any = {}) => r.posAttendanceEventModel.collection.insertOne({ storeId: w.s.storeId, employeeId: w.s.cashierId, type, recordId, deviceAt: at, serverAt: at, at, flags: [], ...extra });
    // day −5: on time 9:05 (inside the grace) to 17:05, 30 min break
    await ev('clock_in', d(5, 9, 5), 'r1'); await ev('break_start', d(5, 12), 'r1'); await ev('break_end', d(5, 12, 30), 'r1'); await ev('clock_out', d(5, 17, 5), 'r1');
    // day −4: 40 minutes late
    await ev('clock_in', d(4, 9, 40), 'r2'); await ev('clock_out', d(4, 17), 'r2');
    // day −3: never clocked out (missing)
    await ev('clock_in', d(3, 9), 'r3');
    const q = { from: new Date(Date.now() - 10 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
    const me = (await team.report(device(w.s), w.s.storeId, q, w.C)).data;
    expect(me.people).toHaveLength(1);
    const p = me.people[0];
    expect(p).toMatchObject({ employeeName: 'Cal Cashier', daysWorked: 3, records: 3, lateCount: 1, lateMinutes: 40, missingClockOuts: 1, breakMinutes: 30, rosteredMinutes: 3 * 8 * 60 });
    expect(p.workedMinutes).toBe((8 * 60 - 30) + (7 * 60 + 20)); // the open record counts no hours until it is closed (by a correction)
    expect(me.totals).toMatchObject({ lateCount: 1, missingClockOuts: 1 });
    expect(await code(team.report(device(w.s), w.s.storeId, { ...q, employeeId: w.s.managerId }, w.C))).toBe('POS_ACTION_FORBIDDEN');
    const all = (await team.report(device(w.s), w.s.storeId, q, w.M)).data;
    expect(all.people.some((x: any) => x.employeeId === w.s.cashierId)).toBe(true);
    expect(await code(team.report(device(w.s), w.s.storeId, { from: q.to, to: q.from }, w.M))).toBe('RANGE_REQUIRED');
    // a correction closes the missing one and the report follows
    const rec = (await team.records(device(w.s), w.s.storeId, q, w.M)).data.records.find((x: any) => x.recordId === 'r3');
    await team.correct(device(w.s), w.s.storeId, { employeeId: w.s.cashierId, recordId: 'r3', clockOutAt: d(3, 17).toISOString(), reason: 'forgot' }, w.M);
    const fixed = (await team.report(device(w.s), w.s.storeId, q, w.M)).data.people.find((x: any) => x.employeeId === w.s.cashierId);
    expect(rec).toBeTruthy();
    expect([fixed!.workedMinutes, fixed!.corrections]).toEqual([(8 * 60 - 30) + (7 * 60 + 20) + 8 * 60, 1]);
  });
});
