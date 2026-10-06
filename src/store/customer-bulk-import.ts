/* eslint-disable prettier/prettier */
import {
  BulkColumn, BulkRowError, parseEmailCell, runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const CUSTOMER_IMPORT_MAX_ROWS = 1000;

export const CUSTOMER_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Name', required: true, description: 'Customer full name.', example: 'Sample Customer' },
  { key: 'Email', required: true, description: 'Unique per store; a customer with this email that already exists is skipped.', example: 'sample.customer@example.com' },
  { key: 'Phone', description: 'Optional phone number.', example: '+1 555 010 0000' },
];

export interface CustomerImportDeps {
  /** True when a (non-deleted) customer account with this email already exists in THIS store. */
  exists: (email: string) => Promise<boolean>;
  /** The real seller-create path (StoreService.createStoreCustomer). */
  create: (dto: { name: string; email: string; phone?: string }) => Promise<unknown>;
}

export function importCustomersCsv(deps: CustomerImportDeps, text: string) {
  return runBulkImport({
    text,
    columns: CUSTOMER_IMPORT_COLUMNS,
    maxRows: CUSTOMER_IMPORT_MAX_ROWS,
    label: 'customer',
    fileDedupeKey: (r) => (r.Email ? r.Email.trim().toLowerCase() : null),
    handler: async (r) => {
      const name = r.Name.trim();
      if (!name) throw new BulkRowError('Name is required');
      if (name.length > 200) throw new BulkRowError('Name is too long (max 200 characters)');
      const email = parseEmailCell(r.Email, 'Email', true) as string;
      const phone = r.Phone.trim();
      if (phone.length > 40) throw new BulkRowError('Phone is too long (max 40 characters)');
      if (await deps.exists(email)) return { outcome: 'skipped', note: 'Customer already exists' };
      await deps.create({ name, email, phone: phone || undefined });
      return { outcome: 'created' };
    },
  });
}
