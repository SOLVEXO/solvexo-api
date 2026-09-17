/* eslint-disable prettier/prettier */

/**
 * Pure, DB-free slot computation — deliberately kept out of any service class
 * so it stays independently unit-testable (no Mongoose model needed to test
 * the actual scheduling math).
 */

export interface WeeklyRuleLike {
  dayOfWeek: number;
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
}

export interface AvailabilityExceptionLike {
  date: Date | string;
  type: 'closed' | 'custom';
  customStart?: string | null;
  customEnd?: string | null;
}

export interface ServiceAvailabilityLike {
  weeklyRules: WeeklyRuleLike[];
  exceptions?: AvailabilityExceptionLike[];
}

export interface ExistingBookingLike {
  startTime: string;
}

export interface AvailableSlot {
  startTime: string;
  endTime: string;
  spotsLeft: number;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function isSameCalendarDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Computes the bookable time slots for one service, on one date, given the
 * service's weekly/exception availability rules and the bookings that
 * already exist for that date.
 *
 * - An exception dated exactly `date` with `type:'closed'` yields zero slots.
 * - An exception with `type:'custom'` overrides that date's start/end time
 *   in place of the matching weekly rule.
 * - Otherwise, the weekly rule matching `date`'s day-of-week (0=Sunday) is
 *   used; no matching rule (day off) yields zero slots.
 * - Slots are generated back-to-back, `durationMinutes` long, from start to
 *   end. A slot whose remaining capacity (`capacityPerSlot` minus how many
 *   existing bookings share that `startTime`) is <= 0 is omitted.
 */
export function computeAvailableSlots(
  availability: ServiceAvailabilityLike | null | undefined,
  durationMinutes: number,
  capacityPerSlot: number,
  date: Date,
  existingBookingsForDate: ExistingBookingLike[],
): AvailableSlot[] {
  if (!availability || !durationMinutes || durationMinutes <= 0) return [];

  const exception = (availability.exceptions ?? []).find((e) => isSameCalendarDate(new Date(e.date), date));
  if (exception?.type === 'closed') return [];

  let startTime: string | undefined;
  let endTime: string | undefined;

  if (exception?.type === 'custom' && exception.customStart && exception.customEnd) {
    startTime = exception.customStart;
    endTime = exception.customEnd;
  } else {
    const dayOfWeek = date.getDay();
    const rule = (availability.weeklyRules ?? []).find((r) => r.dayOfWeek === dayOfWeek);
    if (!rule) return [];
    startTime = rule.startTime;
    endTime = rule.endTime;
  }

  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  if (!(endMinutes > startMinutes)) return [];

  const bookedCountByStart = new Map<string, number>();
  for (const booking of existingBookingsForDate) {
    bookedCountByStart.set(booking.startTime, (bookedCountByStart.get(booking.startTime) ?? 0) + 1);
  }

  const slots: AvailableSlot[] = [];
  for (let cursor = startMinutes; cursor + durationMinutes <= endMinutes; cursor += durationMinutes) {
    const slotStart = minutesToTime(cursor);
    const slotEnd = minutesToTime(cursor + durationMinutes);
    const booked = bookedCountByStart.get(slotStart) ?? 0;
    const spotsLeft = capacityPerSlot - booked;
    if (spotsLeft > 0) {
      slots.push({ startTime: slotStart, endTime: slotEnd, spotsLeft });
    }
  }

  return slots;
}
