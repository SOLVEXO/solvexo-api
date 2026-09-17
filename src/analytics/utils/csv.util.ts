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

/**
 * Minimal RFC-4180-ish CSV parser (no library exists in this codebase —
 * matches `toCsv`'s own hand-rolled style) — handles quoted fields
 * (including an embedded comma or a doubled `""` escaped quote inside one,
 * exactly what `toCsv` itself produces) and both `\n`/`\r\n` line endings.
 * Returns one object per data row, keyed by the header row's own column
 * names — a caller doesn't need to know column ORDER, only names, so a
 * seller re-arranging columns in Excel before re-uploading still works.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const clean = text.replace(/\r\n/g, '\n');

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmptyRows = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmptyRows.length === 0) return [];
  const [headerRow, ...dataRows] = nonEmptyRows;
  const headers = headerRow.map((h) => h.trim());
  return dataRows.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}
