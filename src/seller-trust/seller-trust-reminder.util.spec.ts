import { REMINDABLE_STATUSES, reminderMessage, reminderStage, shouldSendStage } from './seller-trust-reminder.util';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-12-01T09:30:00Z');
const inDays = (n: number) => new Date(now.getTime() + n * DAY);

describe('reminderStage', () => {
  it('is null while the deadline is more than 14 days away, or unknown', () => {
    expect(reminderStage(inDays(20), now)).toBeNull();
    expect(reminderStage(inDays(14.5), now)).toBeNull();
    expect(reminderStage(null, now)).toBeNull();
    expect(reminderStage(undefined, now)).toBeNull();
    expect(reminderStage('not a date', now)).toBeNull();
  });

  it('moves through 14 / 7 / 3 / 1 days as the deadline gets closer', () => {
    expect(reminderStage(inDays(14), now)).toBe('d14');
    expect(reminderStage(inDays(8), now)).toBe('d14');
    expect(reminderStage(inDays(7), now)).toBe('d7');
    expect(reminderStage(inDays(4), now)).toBe('d7');
    expect(reminderStage(inDays(3), now)).toBe('d3');
    expect(reminderStage(inDays(2.2), now)).toBe('d3');
    expect(reminderStage(inDays(1), now)).toBe('d1');
    expect(reminderStage(inDays(0.4), now)).toBe('d1');
  });

  it('is "limited" once the deadline has passed (including the exact moment)', () => {
    expect(reminderStage(now, now)).toBe('limited');
    expect(reminderStage(inDays(-3), now)).toBe('limited');
  });
});

describe('shouldSendStage', () => {
  const due = inDays(3);
  it('sends when nothing was sent yet', () => {
    expect(shouldSendStage('d3', null, due)).toBe(true);
    expect(shouldSendStage('d3', undefined, due)).toBe(true);
  });
  it('never sends the same stage twice for the same deadline', () => {
    expect(shouldSendStage('d3', { stage: 'd3', forDueAt: due }, due)).toBe(false);
  });
  it('sends only a stage further along; never goes back', () => {
    expect(shouldSendStage('d1', { stage: 'd3', forDueAt: due }, due)).toBe(true);
    expect(shouldSendStage('limited', { stage: 'd1', forDueAt: due }, due)).toBe(true);
    expect(shouldSendStage('d7', { stage: 'd3', forDueAt: due }, due)).toBe(false);
    expect(shouldSendStage('d1', { stage: 'limited', forDueAt: due }, due)).toBe(false);
  });
  it('a moved deadline starts the stages over', () => {
    expect(shouldSendStage('d14', { stage: 'd1', forDueAt: inDays(1) }, inDays(10))).toBe(true);
  });
  it('accepts dates given as ISO strings', () => {
    expect(shouldSendStage('d3', { stage: 'd3', forDueAt: due.toISOString() }, due)).toBe(false);
  });
});

describe('reminderMessage', () => {
  const due = new Date('2026-12-05T00:00:00Z');
  it('says how many days are left, names the store and the date, and is honest about what is limited', () => {
    const m = reminderMessage('d7', 'Ali Traders', due);
    expect(m.title).toBe('7 days left to verify your business');
    expect(m.body).toContain('"Ali Traders"');
    expect(m.body).toContain('2026-12-05');
    expect(m.body).toContain('balance Solvexo holds');
    expect(reminderMessage('d1', 'X', due).title).toBe('Last day to verify your business');
    expect(reminderMessage('d14', 'X', due).title).toBe('14 days left to verify your business');
  });
  it('the "limited" notice says what stops and what keeps working', () => {
    const m = reminderMessage('limited', 'Ali Traders', due);
    expect(m.title).toBe('Your store is limited until you verify');
    expect(m.body).toContain('hidden from the Solvexo marketplace');
    expect(m.body).toContain('cash on delivery keep working');
  });
});

describe('REMINDABLE_STATUSES', () => {
  it('never includes a store that is verified or already waiting for Solvexo', () => {
    for (const s of ['verified', 'pending', 'under_review']) expect(REMINDABLE_STATUSES as readonly string[]).not.toContain(s);
  });
});
