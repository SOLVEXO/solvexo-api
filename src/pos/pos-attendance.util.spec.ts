/* eslint-disable prettier/prettier */
import { AttEvent, deriveRecords, effectiveTime, isLive } from './pos-attendance.util';

const T0 = new Date('2026-11-02T08:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000);
let n = 0;
const ev = (type: AttEvent['type'], min: number, extra: Partial<AttEvent> = {}): AttEvent => ({ id: `e${++n}`, type, at: at(min), serverAt: at(min), ...extra });

describe('attendance derivation (pure)', () => {
  it('clock in → break → clock out: hours = span − breaks; the clock-in id is the record id', () => {
    const { records, anomalies } = deriveRecords([ev('clock_in', 0, { recordId: 'r1' }), ev('break_start', 120), ev('break_end', 150), ev('clock_out', 540)], at(600));
    expect(anomalies).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ recordId: 'r1', status: 'closed', workedMinutes: 540 - 30, breakMinutes: 30 });
  });
  it('a clock-out while on a break ends the break at that time', () => {
    const { records } = deriveRecords([ev('clock_in', 0), ev('break_start', 100), ev('clock_out', 130)], at(200));
    expect([records[0].breakMinutes, records[0].workedMinutes]).toEqual([30, 100]);
  });
  it('events are ordered by their effective time, not by arrival (an offline queue)', () => {
    const { records } = deriveRecords([ev('clock_out', 480), ev('clock_in', 0)], at(600));
    expect([records[0].status, records[0].workedMinutes]).toEqual(['closed', 480]);
  });
  it('anomalies: a second clock-in is ignored and flagged; clock-out / break without clock-in flagged', () => {
    const a = deriveRecords([ev('clock_in', 0), ev('clock_in', 5), ev('clock_out', 60)], at(100));
    expect(a.records).toHaveLength(1);
    expect(a.anomalies.map((x) => x.kind)).toEqual(['double_clock_in']);
    const b = deriveRecords([ev('clock_out', 5), ev('break_start', 10), ev('break_end', 20)], at(100));
    expect(b.anomalies.map((x) => x.kind).sort()).toEqual(['break_end_without_start', 'break_without_clock_in', 'clock_out_without_clock_in']);
  });
  it('an open record older than 14 hours is a missing clock-out; a recent one is just open', () => {
    expect(deriveRecords([ev('clock_in', 0)], at(13 * 60)).anomalies).toEqual([]);
    const late = deriveRecords([ev('clock_in', 0, { recordId: 'r' })], at(15 * 60));
    expect(late.anomalies.map((x) => x.kind)).toEqual(['missing_clock_out']);
    expect(late.records[0].flags).toContain('missing_clock_out');
  });
  it('overlapping records of one person are flagged (here: a correction moves the second record on top of the first)', () => {
    const base = [ev('clock_in', 0, { recordId: 'a' }), ev('clock_out', 300), ev('clock_in', 400, { recordId: 'b' }), ev('clock_out', 500)];
    expect(deriveRecords(base, at(600)).anomalies).toEqual([]);
    const moved = deriveRecords([...base, ev('correction', 550, { recordId: 'b', correction: { clockInAt: at(200) } })], at(600));
    expect(moved.anomalies.map((x) => x.kind)).toEqual(['overlap']);
    expect(moved.records.find((x) => x.recordId === 'b')!.flags).toContain('overlap');
  });
  it('corrections apply on top of the raw log: set times, add a missing clock-out (closes it), void — the raw events are untouched', () => {
    const raw = [ev('clock_in', 0, { recordId: 'r1' })];
    const fixed = deriveRecords([...raw, ev('correction', 700, { recordId: 'r1', correction: { clockOutAt: at(480) }, reason: 'forgot' })], at(1000));
    expect(fixed.records[0]).toMatchObject({ status: 'closed', workedMinutes: 480, corrected: true, correctionCount: 1 });
    expect(fixed.anomalies.map((x) => x.kind)).not.toContain('missing_clock_out');
    const moved = deriveRecords([ev('clock_in', 0, { recordId: 'r2' }), ev('clock_out', 480), ev('correction', 700, { recordId: 'r2', correction: { clockInAt: at(30) } }), ev('correction', 710, { recordId: 'r2', correction: { clockInAt: at(60) } })], at(1000));
    expect([moved.records[0].workedMinutes, moved.records[0].correctionCount]).toEqual([420, 2]); // the latest correction wins
    const voided = deriveRecords([ev('clock_in', 0, { recordId: 'r3' }), ev('clock_out', 60), ev('correction', 70, { recordId: 'r3', correction: { voided: true } })], at(100));
    expect(voided.records[0].status).toBe('voided');
  });
  it('time rules: device clock ahead of the server → the server time is used and flagged; a late offline event is flagged; live = within 2 minutes', () => {
    const server = new Date('2026-11-02T10:00:00Z');
    expect(effectiveTime(new Date('2026-11-02T10:02:00Z'), server)).toEqual({ at: new Date('2026-11-02T10:02:00Z'), flags: [] }); // 2 min ahead: within tolerance
    const ahead = effectiveTime(new Date('2026-11-02T10:30:00Z'), server);
    expect([ahead.at.toISOString(), ahead.flags]).toEqual([server.toISOString(), ['device_clock_ahead']]);
    expect(effectiveTime(new Date('2026-11-01T10:00:00Z'), server).flags).toEqual(['late_sync']);
    expect(effectiveTime(new Date('2026-11-02T08:00:00Z'), server).flags).toEqual([]); // 2 h late: normal offline
    expect(isLive(new Date('2026-11-02T09:59:00Z'), server)).toBe(true);
    expect(isLive(new Date('2026-11-02T09:50:00Z'), server)).toBe(false);
  });
});
