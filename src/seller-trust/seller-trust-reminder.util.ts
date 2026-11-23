/* eslint-disable prettier/prettier */
// Pure rules for the AUTOMATIC verification reminders (no database, no Nest): which stage a store is in, whether that stage
// was already sent, and what the message says.
//   d14 / d7 / d3 / d1 = that many days (or fewer) left before the deadline; 'limited' = the deadline passed.

export const REMINDER_STAGES = ['d14', 'd7', 'd3', 'd1', 'limited'] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days before the deadline the first reminder goes out. */
export const FIRST_REMINDER_DAYS = 14;

/** Statuses that still owe the seller an action. A store waiting for OUR review (pending / under_review) is not nagged. */
export const REMINDABLE_STATUSES = ['not_started', 'needs_info', 'rejected'] as const;

/** The stage a store is in right now (the most urgent one reached), or null when the deadline is still far away / unknown. */
export function reminderStage(dueAt: Date | string | null | undefined, now: Date = new Date()): ReminderStage | null {
  if (!dueAt) return null;
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return null;
  if (now.getTime() >= due) return 'limited';
  const daysLeft = Math.ceil((due - now.getTime()) / DAY_MS);
  if (daysLeft <= 1) return 'd1';
  if (daysLeft <= 3) return 'd3';
  if (daysLeft <= 7) return 'd7';
  if (daysLeft <= FIRST_REMINDER_DAYS) return 'd14';
  return null;
}

export interface LastAutoReminder { stage: string; forDueAt: Date | string; at?: Date | string }

/**
 * Send `stage` only when it is further along than the last stage sent FOR THE SAME DEADLINE. A store that enters the
 * window late gets just its current stage (not the ones it missed), and a deadline that moved starts from scratch.
 */
export function shouldSendStage(stage: ReminderStage, last: LastAutoReminder | null | undefined, dueAt: Date | string): boolean {
  if (!last?.forDueAt) return true;
  if (new Date(last.forDueAt).getTime() !== new Date(dueAt).getTime()) return true;
  return REMINDER_STAGES.indexOf(stage) > REMINDER_STAGES.indexOf(last.stage as ReminderStage);
}

const fmt = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Title + body of the in-app notice (and the email built from it). */
export function reminderMessage(stage: ReminderStage, storeName: string, dueAt: Date | string): { title: string; body: string } {
  if (stage === 'limited') {
    return {
      title: 'Your store is limited until you verify',
      body: `"${storeName}" is not verified yet, so it is hidden from the Solvexo marketplace and payouts of any balance Solvexo holds for you are paused. Your own store and cash on delivery keep working. Verify your business to lift these limits.`,
    };
  }
  const days = stage === 'd14' ? 14 : stage === 'd7' ? 7 : stage === 'd3' ? 3 : 1;
  const left = days === 1 ? 'Last day to verify your business' : `${days} days left to verify your business`;
  return {
    title: left,
    body: `Verify "${storeName}" by ${fmt(dueAt)} to stay listed on the Solvexo marketplace and keep payouts of any balance Solvexo holds for you running. It takes about 10 minutes.`,
  };
}
