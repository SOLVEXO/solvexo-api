/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { BulkColumn, BulkRowError, BulkRowResult } from '../common/bulk-import/bulk-import.util';

/**
 * CSV import for the entries of ONE metaobject definition. The columns are
 * dynamic: "Display name*" plus one column per SCALAR field of the definition
 * (header = the field key). Values are validated by the single-entry path
 * (`MetaobjectsService.createEntry` → `assertValueMatchesType`), so the CSV can
 * never accept anything the form would reject.
 *
 * Intentionally NOT covered by the CSV: `json` fields (structured data does not
 * belong in a spreadsheet cell). Those fields are listed in the template guide
 * as "not supported" and are left blank on imported entries — fill them in the
 * entry editor afterwards. A definition with a REQUIRED unsupported field cannot
 * be imported at all (every row would fail the required check).
 */

export const NAME_COLUMN = 'Display name';
export const SUPPORTED_CSV_TYPES = [
  'single_line_text_field', 'multi_line_text_field', 'number_integer',
  'number_decimal', 'boolean', 'date', 'url', 'color',
] as const;

interface FieldDef { key: string; name: string; type: string; required?: boolean }

const TYPE_HELP: Record<string, { description: string; example: string }> = {
  single_line_text_field: { description: 'Text, up to 255 characters.', example: 'Sample text' },
  multi_line_text_field: { description: 'Text, up to 5,000 characters.', example: 'Longer sample text' },
  number_integer: { description: 'Whole number.', example: '10' },
  number_decimal: { description: 'Number, decimals allowed.', example: '10.5' },
  boolean: { description: 'true or false.', example: 'true' },
  date: { description: 'Date, e.g. 2026-01-31.', example: '2026-01-31' },
  url: { description: 'Full link starting with http:// or https://.', example: 'https://example.com' },
  color: { description: 'Hex color, e.g. #FF5500.', example: '#FF5500' },
};

const norm = (s: string) => s.toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]/g, '');

export function isSupportedField(f: FieldDef): boolean {
  return (SUPPORTED_CSV_TYPES as readonly string[]).includes(f.type);
}

/** Column header used for a field (its key; suffixed on the rare clash with the name column). */
export function fieldColumnKey(f: FieldDef): string {
  return norm(f.key) === norm(NAME_COLUMN) ? `${f.key} (field)` : f.key;
}

export function buildEntryColumns(fieldDefinitions: FieldDef[]): BulkColumn[] {
  const cols: BulkColumn[] = [
    {
      key: NAME_COLUMN, required: true,
      description: 'Entry name shown in the list (max 150 characters). Must be unique within this type — an existing name is skipped.',
      example: 'Sample entry',
    },
  ];
  for (const f of fieldDefinitions) {
    if (!isSupportedField(f)) continue;
    const help = TYPE_HELP[f.type];
    cols.push({
      key: fieldColumnKey(f),
      required: !!f.required,
      description: `${f.name} — ${help.description}${f.required ? '' : ' Optional.'}`,
      example: help.example,
    });
  }
  return cols;
}

export function unsupportedFields(fieldDefinitions: FieldDef[]): FieldDef[] {
  return fieldDefinitions.filter((f) => !isSupportedField(f));
}

/** Throws when the definition has a required field the CSV cannot carry. */
export function assertImportable(fieldDefinitions: FieldDef[]): void {
  const blocked = unsupportedFields(fieldDefinitions).filter((f) => f.required);
  if (blocked.length > 0) {
    throw new BadRequestException(
      `This type has required field(s) that cannot be filled from a CSV (${blocked.map((f) => `${f.name} [${f.type}]`).join(', ')}). Add entries in the editor instead.`,
    );
  }
}

/** Extra guide rows for the template response so users see what is left out. */
export function unsupportedGuideColumns(fieldDefinitions: FieldDef[]) {
  return unsupportedFields(fieldDefinitions).map((f) => ({
    key: f.key,
    required: false,
    description: `Not supported in CSV (${f.type}) — not part of the file; fill it in the entry editor after importing.`,
    example: '',
  }));
}

export interface EntryImportDeps {
  storeId: string;
  sellerId: string;
  definitionId: string;
  fieldDefinitions: FieldDef[];
  entryNameExists: (displayName: string) => Promise<boolean>;
  createEntry: (dto: { displayName: string; fields: { key: string; value: string }[] }) => Promise<unknown>;
}

export function makeEntryRowHandler(deps: EntryImportDeps) {
  const supported = deps.fieldDefinitions.filter(isSupportedField);
  return async (record: Record<string, string>): Promise<BulkRowResult> => {
    const displayName = String(record[NAME_COLUMN] ?? '').trim();
    if (!displayName) throw new BulkRowError(`${NAME_COLUMN} is required`);
    if (displayName.length > 150) throw new BulkRowError(`${NAME_COLUMN} cannot exceed 150 characters`);

    if (await deps.entryNameExists(displayName)) {
      return { outcome: 'skipped', note: `Entry "${displayName}" already exists` };
    }

    const fields = supported.map((f) => {
      let value = String(record[fieldColumnKey(f)] ?? '').trim();
      if (f.type === 'boolean') value = value.toLowerCase();
      if (f.required && value === '') throw new BulkRowError(`${fieldColumnKey(f)} is required`);
      return { key: f.key, value };
    });

    // Real create path: ownership, required + per-type validation.
    await deps.createEntry({ displayName, fields });
    return { outcome: 'created' };
  };
}

export function entryFileDedupeKey(record: Record<string, string>): string | null {
  const n = String(record[NAME_COLUMN] ?? '').trim().toLowerCase();
  return n || null;
}
