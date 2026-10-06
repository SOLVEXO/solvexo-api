/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import {
  BulkColumn,
  BulkRowError,
  buildTemplatePayload,
  parseBoolCell,
  parseEmailCell,
  parseEnumCell,
  parseNumberCell,
  readUploadedCsv,
  runBulkImport,
} from './bulk-import.util';

const COLUMNS: BulkColumn[] = [
  { key: 'Name', required: true, description: 'Name', example: 'Sample' },
  { key: 'Price', required: true, description: 'Price', example: '9.99' },
  { key: 'Note', description: 'Note', example: 'demo' },
];

describe('bulk-import engine', () => {
  it('saves valid rows, reports invalid ones with row numbers and original values', async () => {
    const csv = ['Name,Price,Note', 'A,1,x', 'B,oops,y', 'C,3,z'].join('\n');
    const res = await runBulkImport({
      text: csv,
      columns: COLUMNS,
      maxRows: 10,
      label: 'item',
      handler: async (r) => {
        parseNumberCell(r.Price, 'Price', { required: true, min: 0 });
        return { outcome: 'created' };
      },
    });
    expect(res.data.created).toBe(2);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0]).toMatchObject({ row: 3, values: { Name: 'B', Price: 'oops' } });
    expect(res.data.failed[0].error).toContain('Price');
  });

  it('re-uploading only the failed rows works and existing rows are skipped, not duplicated', async () => {
    const existing = new Set(['A']);
    const handler = async (r: Record<string, string>) => {
      if (existing.has(r.Name)) return { outcome: 'skipped' as const, note: 'exists' };
      existing.add(r.Name);
      return { outcome: 'created' as const };
    };
    const full = 'Name,Price\nA,1\nB,2';
    const first = await runBulkImport({ text: full, columns: COLUMNS, maxRows: 10, label: 'item', handler });
    expect(first.data).toMatchObject({ created: 1, skipped: 1, failedCount: 0 });
    const again = await runBulkImport({ text: full, columns: COLUMNS, maxRows: 10, label: 'item', handler });
    expect(again.data).toMatchObject({ created: 0, skipped: 2 });
  });

  it('ignores the untouched template example row and blank rows', async () => {
    const tpl = buildTemplatePayload('t.csv', COLUMNS).data.csv;
    await expect(
      runBulkImport({ text: tpl, columns: COLUMNS, maxRows: 10, label: 'item', handler: async () => ({ outcome: 'created' }) }),
    ).resolves.toMatchObject({ data: { total: 0, created: 0 } });
  });

  it('rejects a file missing a required column', async () => {
    await expect(
      runBulkImport({ text: 'Name\nA', columns: COLUMNS, maxRows: 10, label: 'item', handler: async () => ({ outcome: 'created' }) }),
    ).rejects.toThrow(/missing required column/i);
  });

  it('matches headers loosely, strips a BOM and detects ; delimiters', async () => {
    const seen: Record<string, string>[] = [];
    await runBulkImport({
      text: '﻿name*;PRICE\nA;5',
      columns: COLUMNS,
      maxRows: 10,
      label: 'item',
      handler: async (r) => { seen.push(r); return { outcome: 'created' }; },
    });
    expect(seen[0]).toMatchObject({ Name: 'A', Price: '5' });
  });

  it('fails the second row that repeats a key inside the same file', async () => {
    const res = await runBulkImport({
      text: 'Name,Price\nA,1\nA,2',
      columns: COLUMNS,
      maxRows: 10,
      label: 'item',
      fileDedupeKey: (r) => r.Name.toLowerCase(),
      handler: async () => ({ outcome: 'created' }),
    });
    expect(res.data.created).toBe(1);
    expect(res.data.failed[0].error).toMatch(/Duplicate of row 2/);
  });

  it('enforces maxRows and turns BulkRowError / HttpException into per-row errors', async () => {
    await expect(
      runBulkImport({ text: 'Name,Price\nA,1\nB,2', columns: COLUMNS, maxRows: 1, label: 'item', handler: async () => ({ outcome: 'created' }) }),
    ).rejects.toThrow(/capped at 1 rows/);
    const res = await runBulkImport({
      text: 'Name,Price\nA,1\nB,2',
      columns: COLUMNS,
      maxRows: 5,
      label: 'item',
      handler: async (r) => {
        if (r.Name === 'A') throw new BulkRowError('nope');
        throw new BadRequestException(['x is bad', 'y is bad']);
      },
    });
    expect(res.data.failed.map((f) => f.error)).toEqual(['nope', 'x is bad; y is bad']);
  });

  it('cell parsers validate', () => {
    expect(parseNumberCell('1,200.5', 'P')).toBe(1200.5);
    expect(() => parseNumberCell('-1', 'P', { min: 0 })).toThrow(BulkRowError);
    expect(() => parseNumberCell('1.5', 'P', { integer: true })).toThrow(BulkRowError);
    expect(parseBoolCell('Yes', 'B')).toBe(true);
    expect(() => parseBoolCell('maybe', 'B')).toThrow(BulkRowError);
    expect(parseEnumCell('ACTIVE', 'S', ['active', 'draft'] as const)).toBe('active');
    expect(() => parseEnumCell('x', 'S', ['active'] as const)).toThrow(BulkRowError);
    expect(parseEmailCell(' A@B.com ')).toBe('a@b.com');
    expect(() => parseEmailCell('nope')).toThrow(BulkRowError);
  });

  it('readUploadedCsv only accepts .csv within the size cap', () => {
    expect(() => readUploadedCsv(undefined)).toThrow(BadRequestException);
    expect(() => readUploadedCsv({ buffer: Buffer.from('a'), originalname: 'x.xlsx' })).toThrow(/Only .csv/);
    expect(readUploadedCsv({ buffer: Buffer.from('a,b'), originalname: 'x.CSV' })).toBe('a,b');
  });
});
