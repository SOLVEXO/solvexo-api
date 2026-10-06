/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const STORE_FAQ_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Question', required: true, description: 'The question. Unique per store (case-insensitive).', example: 'Do you ship internationally?' },
  { key: 'Answer', required: true, description: 'The answer shown to buyers.', example: 'Yes, we ship to most countries within 5-10 business days.' },
  { key: 'Order', description: 'Optional display order, whole number 0 or more (lower shows first).', example: '0' },
  { key: 'Status', description: 'active or inactive (default active).', example: 'active' },
];

export const STORE_FAQ_IMPORT_MAX_ROWS = 1000;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export interface StoreFaqImportDeps {
  storeFaqModel: any;
  /** StoreFaqService-like: create (the REAL create path). */
  storeFaqService: {
    create(storeId: string, sellerId: string, dto: any): Promise<any>;
  };
}

export async function importStoreFaqsCsv(deps: StoreFaqImportDeps, sellerId: string, storeId: string, text: string) {
  const { storeFaqModel, storeFaqService } = deps;
  return runBulkImport({
    text,
    columns: STORE_FAQ_IMPORT_COLUMNS,
    maxRows: STORE_FAQ_IMPORT_MAX_ROWS,
    label: 'FAQ',
    fileDedupeKey: (r) => (r.Question ? norm(r.Question) : null),
    handler: async (r) => {
      const question = r.Question.trim();
      const answer = r.Answer.trim();
      if (!question) throw new BulkRowError('Question is required');
      if (!answer) throw new BulkRowError('Answer is required');
      const order = parseNumberCell(r.Order, 'Order', { min: 0, integer: true });
      const status = parseEnumCell(r.Status, 'Status', ['active', 'inactive'] as const) ?? 'active';

      // Case-insensitive, whitespace-tolerant match (collapse runs of spaces).
      const pattern = new RegExp(`^\\s*${escapeRegex(question.replace(/\s+/g, ' ')).replace(/ /g, '\\s+')}\\s*$`, 'i');
      const existing = await storeFaqModel.findOne({ storeId, question: pattern });
      if (existing) return { outcome: 'skipped', note: 'A FAQ with this question already exists' };

      await storeFaqService.create(storeId, sellerId, {
        question,
        answer,
        ...(order !== undefined ? { order } : {}),
        isActive: status === 'active',
      });
      return { outcome: 'created' };
    },
  });
}
