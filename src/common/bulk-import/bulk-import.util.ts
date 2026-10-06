/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { parseCsv, toCsv } from '../../analytics/utils/csv.util';

/**
 * Shared bulk-import engine (CSV). Every module that supports "download a
 * template → fill it → upload it" declares ONLY its columns and a per-row
 * handler; everything else (parsing, header check, per-row validation
 * reporting, duplicate rows inside one file, template generation, the
 * response shape the frontend `BulkImportDialog` renders) lives here, so the
 * template and the validation can never drift apart.
 *
 * Semantics (Shopify-style):
 *  - every row is processed independently — valid rows are saved, invalid
 *    rows are reported with row number + reason and NOT saved;
 *  - the seller fixes only the failed rows and re-uploads them;
 *  - a row that already exists (matched by the module's own unique key) is
 *    reported as `skipped` (or `updated` where the module chooses to update),
 *    never created twice — so re-uploading the whole file is safe.
 */

export interface BulkColumn {
  /** Header name in the CSV and key of the value handed to the row handler. */
  key: string;
  required?: boolean;
  /** One short sentence shown to the user (rules, allowed values, format). */
  description: string;
  /** Value placed in the template's example row. */
  example: string;
}

export type BulkRowOutcome = 'created' | 'updated' | 'skipped';

export interface BulkRowResult {
  outcome: BulkRowOutcome;
  /** Optional human note, e.g. "Already exists (SKU ABC-1)". Shown for skipped rows. */
  note?: string;
}

/** Throw from a row handler to fail ONE row with a user-facing reason. */
export class BulkRowError extends Error {}

export interface BulkRowFailure {
  row: number;
  error: string;
  /** The row's original cell values, so the failed-rows file can be rebuilt. */
  values: Record<string, string>;
}

export interface BulkSkippedRow {
  row: number;
  note: string;
}

export interface BulkImportData {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failedCount: number;
  /** Capped at MAX_REPORTED_FAILURES; `failedCount` is always the true number. */
  failed: BulkRowFailure[];
  skippedRows: BulkSkippedRow[];
  /** Header order for rebuilding the failed-rows file. */
  columns: string[];
}

export const MAX_REPORTED_FAILURES = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Lower-case and drop everything but letters/digits so "Compare-at Price",
 *  "compare_at_price" and "COMPARE AT PRICE*" all match one column. */
function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]/g, '');
}

function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts: [string, number][] = [
    [',', (firstLine.match(/,/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Validates an uploaded file and returns its text (CSV only, 5 MB). */
export function readUploadedCsv(file: { buffer?: Buffer; originalname?: string; size?: number } | undefined): string {
  if (!file || !file.buffer) throw new BadRequestException('No CSV file uploaded');
  const name = (file.originalname ?? '').toLowerCase();
  if (name && !name.endsWith('.csv')) {
    throw new BadRequestException('Only .csv files are supported. In Excel use "Save as → CSV UTF-8".');
  }
  if (file.buffer.length > MAX_FILE_BYTES) {
    throw new BadRequestException('The file is larger than 5 MB — split it into smaller files.');
  }
  return file.buffer.toString('utf-8');
}

/** Template download payload: `{ filename, csv, columns }` (JSON, so the
 *  frontend's axios client can unwrap it like every other endpoint). */
export function buildTemplatePayload(filename: string, columns: BulkColumn[]) {
  const csv =
    '﻿' +
    toCsv(
      columns.map((c) => c.key),
      [columns.map((c) => c.example)],
    ) +
    '\n';
  return {
    success: true,
    data: {
      filename,
      csv,
      columns: columns.map((c) => ({
        key: c.key,
        required: !!c.required,
        description: c.description,
        example: c.example,
      })),
    },
  };
}

export interface RunBulkImportOptions {
  text: string;
  columns: BulkColumn[];
  maxRows: number;
  /** Singular/plural noun for the summary message, e.g. 'product'. */
  label: string;
  /**
   * Processes one row. `record` is keyed by `BulkColumn.key` (trimmed
   * strings, '' when blank). Return the outcome, or throw `BulkRowError` /
   * any Error to fail that row only.
   */
  handler: (record: Record<string, string>, rowNumber: number) => Promise<BulkRowResult>;
  /** Optional: a key that must be unique INSIDE the file (e.g. the SKU). A
   *  later row with the same key fails with a clear message. */
  fileDedupeKey?: (record: Record<string, string>) => string | null;
  /** Rows processed at once (default 1 = strictly in order). */
  concurrency?: number;
}

/** Parses the CSV, runs the handler per row and builds the response. */
export async function runBulkImport(opts: RunBulkImportOptions) {
  const { text, columns, maxRows, label, handler } = opts;
  const rows = parseCsv(text, detectDelimiter(text));
  if (rows.length === 0) throw new BadRequestException('The CSV file has no data rows.');
  if (rows.length > maxRows) {
    throw new BadRequestException(
      `A single import is capped at ${maxRows} rows — split larger files into several.`,
    );
  }

  // Map the file's header names onto the module's canonical column keys.
  const fileHeaders = Object.keys(rows[0]);
  const keyByNormalised = new Map(columns.map((c) => [normaliseHeader(c.key), c.key]));
  const headerToKey = new Map<string, string>();
  for (const h of fileHeaders) {
    const key = keyByNormalised.get(normaliseHeader(h));
    if (key && !headerToKey.has(h)) headerToKey.set(h, key);
  }
  const presentKeys = new Set(headerToKey.values());
  const missing = columns.filter((c) => c.required && !presentKeys.has(c.key)).map((c) => c.key);
  if (missing.length > 0) {
    throw new BadRequestException(
      `The file is missing required column(s): ${missing.join(', ')}. Download the template and use its header row.`,
    );
  }
  if (presentKeys.size === 0) {
    throw new BadRequestException('None of the column names match the template. Download the template and use its header row.');
  }

  const exampleRow = columns.map((c) => c.example.trim());
  const failed: BulkRowFailure[] = [];
  const skippedRows: BulkSkippedRow[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failedCount = 0;
  let considered = 0;
  const seenKeys = new Map<string, number>();

  const fail = (row: number, error: string, values: Record<string, string>) => {
    failedCount++;
    if (failed.length < MAX_REPORTED_FAILURES) failed.push({ row, error, values });
  };

  type Job = { rowNumber: number; record: Record<string, string> };
  const jobs: Job[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2; // +1 header, +1 for 1-based counting
    const record: Record<string, string> = {};
    for (const c of columns) record[c.key] = '';
    for (const [h, key] of headerToKey) record[key] = (rows[i][h] ?? '').trim();

    // The untouched template example row is not data.
    if (columns.every((c, idx) => record[c.key] === exampleRow[idx])) continue;
    // Fully blank after mapping (e.g. only unknown columns filled).
    if (columns.every((c) => record[c.key] === '')) continue;

    considered++;
    if (opts.fileDedupeKey) {
      const k = opts.fileDedupeKey(record);
      if (k) {
        const first = seenKeys.get(k);
        if (first !== undefined) {
          fail(rowNumber, `Duplicate of row ${first} in this file (${k})`, record);
          continue;
        }
        seenKeys.set(k, rowNumber);
      }
    }
    jobs.push({ rowNumber, record });
  }

  const runJob = async (job: Job) => {
    try {
      const res = await handler(job.record, job.rowNumber);
      if (res.outcome === 'created') created++;
      else if (res.outcome === 'updated') updated++;
      else {
        skipped++;
        skippedRows.push({ row: job.rowNumber, note: res.note ?? 'Already exists — skipped' });
      }
    } catch (err: any) {
      const msg =
        err instanceof BulkRowError || err?.getStatus
          ? (typeof err.getResponse === 'function' ? flattenNestMessage(err.getResponse()) : err.message)
          : err?.message ?? 'Could not import this row';
      fail(job.rowNumber, msg || 'Could not import this row', job.record);
    }
  };

  const concurrency = Math.max(1, opts.concurrency ?? 1);
  for (let i = 0; i < jobs.length; i += concurrency) {
    await Promise.all(jobs.slice(i, i + concurrency).map(runJob));
  }

  failed.sort((a, b) => a.row - b.row);
  skippedRows.sort((a, b) => a.row - b.row);

  const parts = [`${created} added`];
  if (updated) parts.push(`${updated} updated`);
  if (skipped) parts.push(`${skipped} skipped (already exist)`);
  if (failedCount) parts.push(`${failedCount} failed`);
  const data: BulkImportData = {
    total: considered,
    created,
    updated,
    skipped,
    failedCount,
    failed,
    skippedRows,
    columns: columns.map((c) => c.key),
  };
  return {
    success: true,
    message: `${parts.join(', ')} — ${label}${considered === 1 ? '' : 's'} in file: ${considered}.`,
    data,
  };
}

function flattenNestMessage(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  const m = (resp as any)?.message;
  if (Array.isArray(m)) return m.join('; ');
  return typeof m === 'string' ? m : 'Invalid value';
}

// ── tiny value parsers shared by the module handlers ────────────────────────

/** Parses a required/optional number cell; throws BulkRowError with the column name. */
export function parseNumberCell(
  raw: string,
  column: string,
  opts: { required?: boolean; min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const v = raw.trim();
  if (v === '') {
    if (opts.required) throw new BulkRowError(`${column} is required`);
    return undefined;
  }
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new BulkRowError(`${column} must be a number (got "${raw}")`);
  if (opts.integer && !Number.isInteger(n)) throw new BulkRowError(`${column} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw new BulkRowError(`${column} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new BulkRowError(`${column} must be at most ${opts.max}`);
  return n;
}

/** Parses yes/no style cells. Blank → undefined. */
export function parseBoolCell(raw: string, column: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (['true', 'yes', 'y', '1', 'active'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'inactive'].includes(v)) return false;
  throw new BulkRowError(`${column} must be yes or no`);
}

/** Validates a cell against an allow-list (case-insensitive). Blank → undefined. */
export function parseEnumCell<T extends string>(raw: string, column: string, allowed: readonly T[]): T | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  const hit = allowed.find((a) => a.toLowerCase() === v);
  if (!hit) throw new BulkRowError(`${column} must be one of: ${allowed.join(', ')}`);
  return hit;
}

/** Splits a `;`-separated list cell. */
export function parseListCell(raw: string): string[] {
  return raw.split(';').map((s) => s.trim()).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function parseEmailCell(raw: string, column = 'Email', required = true): string | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '') {
    if (required) throw new BulkRowError(`${column} is required`);
    return undefined;
  }
  if (v.length > 254 || !EMAIL_RE.test(v)) throw new BulkRowError(`${column} is not a valid email address`);
  return v;
}
