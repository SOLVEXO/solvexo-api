/* eslint-disable prettier/prettier */
import { runBulkImport } from '../common/bulk-import/bulk-import.util';
import {
  assertImportable, buildEntryColumns, entryFileDedupeKey, makeEntryRowHandler, unsupportedGuideColumns,
} from './metaobject-entries-bulk-import';

const defs = [
  { key: 'role', name: 'Role', type: 'single_line_text_field', required: true },
  { key: 'age', name: 'Age', type: 'number_integer' },
  { key: 'site', name: 'Website', type: 'url' },
  { key: 'extra', name: 'Extra', type: 'json' },
];

function setup(existing: string[] = []) {
  const created: any[] = [];
  const names = new Set(existing.map((n) => n.toLowerCase()));
  const handler = makeEntryRowHandler({
    storeId: 's1', sellerId: 'u1', definitionId: 'd1', fieldDefinitions: defs,
    entryNameExists: async (n) => names.has(n.toLowerCase()),
    createEntry: async (dto) => {
      // mimic the real per-type validation
      const age = dto.fields.find((f) => f.key === 'age')!.value;
      if (age !== '' && !/^-?\d+$/.test(age)) throw new Error('Age must be a whole number');
      created.push(dto);
    },
  });
  const run = (csv: string) => runBulkImport({ text: csv, columns: buildEntryColumns(defs), maxRows: 100, label: 'entry', handler, fileDedupeKey: entryFileDedupeKey });
  return { created, run };
}

describe('metaobject entries bulk import', () => {
  it('builds columns from scalar fields only and lists json as unsupported', () => {
    expect(buildEntryColumns(defs).map((c) => c.key)).toEqual(['Display name', 'role', 'age', 'site']);
    expect(unsupportedGuideColumns(defs)[0].key).toBe('extra');
  });

  it('blocks definitions with a required unsupported field', () => {
    expect(() => assertImportable([{ key: 'j', name: 'J', type: 'json', required: true }])).toThrow();
    expect(() => assertImportable(defs)).not.toThrow();
  });

  it('creates valid rows, reports bad ones, skips existing, rejects in-file duplicate', async () => {
    const { created, run } = setup(['Jane']);
    const res: any = await run(
      'Display name,role,age,site\nJane,Dev,3,\nBob,Dev,5,https://x.com\nAmy,,1,\nCid,Dev,abc,\nbob,Dev,6,\n',
    );
    expect(res.data.created).toBe(1);
    expect(res.data.skipped).toBe(1);
    expect(res.data.failedCount).toBe(3);
    expect(created[0].displayName).toBe('Bob');
    expect(created[0].fields.find((f: any) => f.key === 'extra')).toBe(undefined);
    const errs = res.data.failed.map((f: any) => f.error).join('|');
    expect(errs).toContain('role is required');
    expect(errs).toContain('Age must be a whole number');
    expect(errs).toContain('Duplicate of row');
  });

  it('rejects a file missing a required column', async () => {
    const { run } = setup();
    await expect(run('Display name,age\nA,1\n')).rejects.toThrow();
  });
});
