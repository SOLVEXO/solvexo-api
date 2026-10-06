/* eslint-disable prettier/prettier */
import {
  BulkColumn, parseEmailCell, runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const SUBSCRIBER_IMPORT_MAX_ROWS = 5000;

// The subscriber schema stores only the email (+ consent metadata), so the
// template has a single column.
export const SUBSCRIBER_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Email', required: true, description: 'Unique per store; already-subscribed and previously-unsubscribed addresses are skipped.', example: 'sample.subscriber@example.com' },
];

export type SubscriberState = 'active' | 'unsubscribed' | 'none';

export interface SubscriberImportDeps {
  /** State of this email on THIS store's list ('none' when absent; a pending double opt-in counts as 'none'). */
  getState: (email: string) => Promise<SubscriberState>;
  /** Records seller-attested consent (setMarketingConsent, source 'import'). */
  subscribe: (email: string) => Promise<unknown>;
}

export function importSubscribersCsv(deps: SubscriberImportDeps, text: string) {
  return runBulkImport({
    text,
    columns: SUBSCRIBER_IMPORT_COLUMNS,
    maxRows: SUBSCRIBER_IMPORT_MAX_ROWS,
    label: 'subscriber',
    fileDedupeKey: (r) => (r.Email ? r.Email.trim().toLowerCase() : null),
    handler: async (r) => {
      const email = parseEmailCell(r.Email, 'Email', true) as string;
      const state = await deps.getState(email);
      if (state === 'active') return { outcome: 'skipped', note: 'Already subscribed' };
      if (state === 'unsubscribed') {
        return { outcome: 'skipped', note: 'Previously unsubscribed — not re-added' };
      }
      await deps.subscribe(email);
      return { outcome: 'created' };
    },
  });
}
