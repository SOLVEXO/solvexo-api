/* eslint-disable prettier/prettier */
/**
 * Spreadsheet formula injection guard: a text cell starting with = + - @ (or tab/CR) would be run as a formula when the
 * CSV is opened in Excel/Sheets (product and customer names are user-supplied). Plain numbers written as text ("-5.00") are kept.
 */
function safeText(value: unknown): string {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
}

/**
 * Minimal CSV builder matching the hand-rolled style already used in
 * `subscriptions.service.ts#exportCsv` / `finance.service.ts` (no CSV
 * library exists in this codebase) — header row + comma-joined rows,
 * string fields quoted, numbers left bare.
 */
/** Most data rows an analytics CSV export contains; bigger result sets are cut and say so in the file (see `limitCsvRows`). */
export const CSV_ROW_LIMIT = 20000;

/**
 * Cuts `rows` to CSV_ROW_LIMIT and, when something was cut, appends a visible last row so nobody mistakes a partial
 * export for the full data. Query for CSV_ROW_LIMIT + 1 rows so truncation can be detected.
 */
export function limitCsvRows<T extends (string | number)[]>(rows: T[], width: number): (string | number)[][] {
  if (rows.length <= CSV_ROW_LIMIT) return rows;
  const note: (string | number)[] = [`NOTE: export limited to the first ${CSV_ROW_LIMIT} rows - narrow the date range for the rest`];
  while (note.length < width) note.push('');
  return [...rows.slice(0, CSV_ROW_LIMIT), note];
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const header = headers.join(',') + '\n';
  const body = rows
    .map((row) =>
      row
        .map((cell) => (typeof cell === 'number' ? cell.toString() : `"${safeText(cell).replace(/"/g, '""')}"`))
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
export function parseCsv(text: string, delimiter: string = ','): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Strip a UTF-8 BOM (Excel's "CSV UTF-8" adds one and it would otherwise
  // glue itself onto the first header name).
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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
    } else if (ch === delimiter) {
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
