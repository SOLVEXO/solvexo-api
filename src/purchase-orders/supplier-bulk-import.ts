/* eslint-disable prettier/prettier */
import {
  BulkColumn, BulkRowError, parseEmailCell, runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const SUPPLIER_IMPORT_MAX_ROWS = 1000;

export const SUPPLIER_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Name', required: true, description: 'Supplier name. Unique per store (case-insensitive); an existing name is skipped.', example: 'Sample Supplier Co' },
  { key: 'Email', description: 'Optional. A supplier already using this email is skipped.', example: 'orders@samplesupplier.com' },
  { key: 'Phone', description: 'Optional phone number.', example: '+1 555 010 0100' },
  { key: 'Address', description: 'Optional address.', example: '12 Market Street, Springfield' },
  { key: 'Notes', description: 'Optional internal notes.', example: 'Net 30 terms' },
];

export interface SupplierImportDeps {
  /** Existing (non-deleted) suppliers of THIS store: names and emails, lower-cased by the caller or here. */
  listExisting: () => Promise<{ name?: string | null; email?: string | null }[]>;
  /** The real create path (PurchaseOrdersService.createSupplier). */
  create: (dto: { name: string; email?: string; phone?: string; address?: string; notes?: string }) => Promise<unknown>;
}

export async function importSuppliersCsv(deps: SupplierImportDeps, text: string) {
  const existing = await deps.listExisting();
  const names = new Set<string>();
  const emails = new Set<string>();
  for (const s of existing) {
    if (s.name) names.add(s.name.trim().toLowerCase());
    if (s.email) emails.add(s.email.trim().toLowerCase());
  }
  return runBulkImport({
    text,
    columns: SUPPLIER_IMPORT_COLUMNS,
    maxRows: SUPPLIER_IMPORT_MAX_ROWS,
    label: 'supplier',
    fileDedupeKey: (r) => (r.Name ? `name:${r.Name.trim().toLowerCase()}` : null),
    handler: async (r) => {
      const name = r.Name.trim();
      if (!name) throw new BulkRowError('Name is required');
      if (name.length > 200) throw new BulkRowError('Name is too long (max 200 characters)');
      const email = parseEmailCell(r.Email, 'Email', false);
      const phone = r.Phone.trim();
      const address = r.Address.trim();
      const notes = r.Notes.trim();
      if (phone.length > 40) throw new BulkRowError('Phone is too long (max 40 characters)');
      if (address.length > 500) throw new BulkRowError('Address is too long (max 500 characters)');
      if (notes.length > 2000) throw new BulkRowError('Notes is too long (max 2000 characters)');

      const nameKey = name.toLowerCase();
      if (names.has(nameKey)) return { outcome: 'skipped', note: 'Supplier already exists (same name)' };
      if (email && emails.has(email)) return { outcome: 'skipped', note: 'Supplier already exists (same email)' };

      await deps.create({
        name,
        email: email || undefined,
        phone: phone || undefined,
        address: address || undefined,
        notes: notes || undefined,
      });
      // Keep later rows of the same file consistent (email may repeat across different names).
      names.add(nameKey);
      if (email) emails.add(email);
      return { outcome: 'created' };
    },
  });
}
