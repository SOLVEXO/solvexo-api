import { addYears, allKycFiles, closedAtOf, closedStoreDue, expiredDraftDocs } from './kyc-retention.util';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-12-01T05:20:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const doc = (publicId: string, uploadedAt: Date | null) => ({ type: 'owner_id', publicId, resourceType: 'raw', uploadedAt });

describe('addYears', () => {
  it('adds calendar years (and subtracts with a negative number)', () => {
    expect(addYears('2026-03-10T00:00:00Z', 6).toISOString()).toBe('2032-03-10T00:00:00.000Z');
    expect(addYears('2026-12-01T00:00:00Z', -6).toISOString()).toBe('2020-12-01T00:00:00.000Z');
  });
});

describe('closedAtOf', () => {
  it('uses the recorded closing date, else the last update, else creation; null when nothing is known', () => {
    expect(closedAtOf({ verificationClosedAt: '2026-01-05T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' })?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(closedAtOf({ updatedAt: '2026-06-01T00:00:00Z' })?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(closedAtOf({ createdAt: '2025-06-01T00:00:00Z' })?.toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(closedAtOf({})).toBeNull();
    expect(closedAtOf({ verificationClosedAt: 'garbage' })).toBeNull();
  });
});

describe('closedStoreDue', () => {
  const closed = (years: number, extra: any = {}) => ({ verificationClosedAt: addYears(now, -years), verification: { submitted: true }, ...extra });

  it('a store that never submitted anything is erased at once', () => {
    expect(closedStoreDue({ verificationClosedAt: daysAgo(1), verification: { submitted: false } }, 6, now)).toBe(true);
    expect(closedStoreDue({ verificationClosedAt: daysAgo(1), verification: null }, 6, now)).toBe(true);
  });

  it('a store that went through verification is kept until the retention years after closing, then erased', () => {
    expect(closedStoreDue(closed(5), 6, now)).toBe(false);
    expect(closedStoreDue({ verificationClosedAt: new Date('2020-12-02T00:00:00Z'), verification: { submitted: true } }, 6, now)).toBe(false); // a day short
    expect(closedStoreDue({ verificationClosedAt: new Date('2020-12-01T05:20:00Z'), verification: { submitted: true } }, 6, now)).toBe(true); // exactly 6 years
    expect(closedStoreDue(closed(7), 6, now)).toBe(true);
  });

  it('follows the configured number of years', () => {
    expect(closedStoreDue(closed(2), 1, now)).toBe(true);
    expect(closedStoreDue(closed(2), 3, now)).toBe(false);
  });

  it('never erases a submitted store whose closing date is unknown', () => {
    expect(closedStoreDue({ verification: { submitted: true } }, 6, now)).toBe(false);
  });
});

describe('expiredDraftDocs', () => {
  it('not_started: each file expires on its own age counted from its upload', () => {
    const store = { verificationStatus: 'not_started', verification: { documents: [doc('old', daysAgo(91)), doc('exact', daysAgo(90)), doc('fresh', daysAgo(10)), doc('undated', null)] } };
    expect(expiredDraftDocs(store, 90, now).map((d) => d.publicId)).toEqual(['old', 'exact']);
  });

  it('a missing status counts as not_started', () => {
    expect(expiredDraftDocs({ verification: { documents: [doc('old', daysAgo(120))] } }, 90, now)).toHaveLength(1);
  });

  it('rejected / needs_info: every file once the decision is older than the period, none before, none without a decision date', () => {
    const docs = [doc('a', daysAgo(400)), doc('b', daysAgo(5))];
    for (const status of ['rejected', 'needs_info']) {
      expect(expiredDraftDocs({ verificationStatus: status, reviewedAt: daysAgo(91), verification: { documents: docs } }, 90, now)).toHaveLength(2);
      expect(expiredDraftDocs({ verificationStatus: status, reviewedAt: daysAgo(30), verification: { documents: docs } }, 90, now)).toHaveLength(0);
      expect(expiredDraftDocs({ verificationStatus: status, reviewedAt: null, verification: { documents: docs } }, 90, now)).toHaveLength(0);
    }
  });

  it('files under review or of a verified store are never expired, however old', () => {
    for (const status of ['pending', 'under_review', 'verified']) {
      expect(expiredDraftDocs({ verificationStatus: status, reviewedAt: daysAgo(900), verification: { documents: [doc('a', daysAgo(900))] } }, 90, now)).toEqual([]);
    }
  });

  it('follows the configured number of days and handles no documents', () => {
    const store = { verificationStatus: 'not_started', verification: { documents: [doc('a', daysAgo(40))] } };
    expect(expiredDraftDocs(store, 30, now)).toHaveLength(1);
    expect(expiredDraftDocs(store, 60, now)).toHaveLength(0);
    expect(expiredDraftDocs({ verificationStatus: 'not_started', verification: { documents: [] } }, 90, now)).toEqual([]);
    expect(expiredDraftDocs({ verificationStatus: 'not_started', verification: null }, 90, now)).toEqual([]);
  });
});

describe('allKycFiles', () => {
  it('lists the live files and the files waiting in a change request', () => {
    expect(allKycFiles({ documents: [doc('a', null)], change: { documents: [doc('b', null)] } }).map((d) => d.publicId)).toEqual(['a', 'b']);
    expect(allKycFiles({ documents: [doc('a', null)], change: null }).map((d) => d.publicId)).toEqual(['a']);
    expect(allKycFiles(null)).toEqual([]);
    expect(allKycFiles(undefined)).toEqual([]);
  });
});
