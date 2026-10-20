/* eslint-disable prettier/prettier */
import {
  BulkColumn, BulkRowError, parseBoolCell, parseEmailCell, runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const CUSTOMER_IMPORT_MAX_ROWS = 1000;

export const CUSTOMER_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Name', required: true, description: 'Customer full name.', example: 'Sample Customer' },
  { key: 'Email', required: true, description: 'Unique per store; a customer with this email that already exists is skipped.', example: 'sample.customer@example.com' },
  { key: 'Phone', description: 'Optional phone number.', example: '+1 555 010 0000' },
  { key: 'Accepts Email Marketing', description: 'Optional yes/no. "yes" subscribes the customer to marketing emails and needs the consent box ticked on the import screen.', example: 'no' },
];

export interface CustomerImportDeps {
  /** True when a (non-deleted) customer account with this email already exists in THIS store. */
  exists: (email: string) => Promise<boolean>;
  /** The real seller-create path (StoreService.createStoreCustomer). */
  create: (dto: { name: string; email: string; phone?: string; marketingConsent?: boolean }) => Promise<unknown>;
}

/** `consentConfirmed`: the seller ticked "these customers agreed to receive marketing emails" — without it a "yes" row is rejected, never silently subscribed. */
export function importCustomersCsv(deps: CustomerImportDeps, text: string, opts: { consentConfirmed?: boolean } = {}) {
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
      const accepts = parseBoolCell(r['Accepts Email Marketing'] ?? '', 'Accepts Email Marketing');
      if (accepts && !opts.consentConfirmed) {
        throw new BulkRowError('Accepts Email Marketing is "yes" — tick the consent box on the import screen to confirm these customers agreed');
      }
      if (await deps.exists(email)) return { outcome: 'skipped', note: 'Customer already exists' };
      await deps.create({ name, email, phone: phone || undefined, marketingConsent: accepts ? true : undefined });
      return { outcome: 'created' };
    },
  });
}
