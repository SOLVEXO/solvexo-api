/* eslint-disable prettier/prettier */
/**
 * Minimal CSV builder matching the hand-rolled style already used in
 * `subscriptions.service.ts#exportCsv` / `finance.service.ts` (no CSV
 * library exists in this codebase) — header row + comma-joined rows,
 * string fields quoted, numbers left bare.
 */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const header = headers.join(',') + '\n';
  const body = rows
    .map((row) =>
      row
        .map((cell) => (typeof cell === 'number' ? cell.toString() : `"${String(cell ?? '').replace(/"/g, '""')}"`))
        .join(','),
    )
    .join('\n');
  return header + body;
}
