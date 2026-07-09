/* eslint-disable prettier/prettier */
/** Round to 2 decimal places — the shared money-rounding convention used across analytics and finance. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
