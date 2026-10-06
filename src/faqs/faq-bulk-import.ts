/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseBoolCell,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { CreateFaqDto } from './dto/faq.dto';

export const FAQ_IMPORT_MAX_ROWS = 1000;

export const FAQ_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Question', required: true, description: 'The FAQ question. A question that already exists (case-insensitive) is skipped, not duplicated.', example: 'How do I reset my password?' },
  { key: 'Answer', required: true, description: 'The answer text shown under the question.', example: 'Click "Forgot password" on the login page and follow the email link.' },
  { key: 'Category', description: 'Optional group such as account, billing or general. Blank = general.', example: 'account' },
  { key: 'Order', description: 'Optional whole number, lower shows first. Blank = 0.', example: '1' },
  { key: 'Active', description: 'yes or no. Blank = yes.', example: 'yes' },
];

const normQ = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export interface FaqImportDeps {
  /** Existing FAQ questions (all, including inactive). */
  listQuestions: () => Promise<string[]>;
  /** `FaqService.create`. */
  create: (dto: CreateFaqDto) => Promise<unknown>;
}

export async function importFaqsCsv(deps: FaqImportDeps, text: string) {
  const existing = new Set((await deps.listQuestions()).map(normQ));
  return runBulkImport({
    text,
    columns: FAQ_IMPORT_COLUMNS,
    maxRows: FAQ_IMPORT_MAX_ROWS,
    label: 'FAQ',
    fileDedupeKey: (r) => (r['Question'] ? normQ(r['Question']) : null),
    handler: async (r) => {
      if (!r['Question']) throw new BulkRowError('Question is required');
      if (!r['Answer']) throw new BulkRowError('Answer is required');
      const order = parseNumberCell(r['Order'], 'Order', { min: 0, integer: true });
      const isActive = parseBoolCell(r['Active'], 'Active');
      const key = normQ(r['Question']);
      if (existing.has(key)) return { outcome: 'skipped', note: 'This question already exists' };

      const dto = new CreateFaqDto();
      dto.question = r['Question'];
      dto.answer = r['Answer'];
      if (r['Category']) dto.category = r['Category'];
      if (order !== undefined) dto.order = order;
      if (isActive !== undefined) dto.isActive = isActive;
      await deps.create(dto);
      existing.add(key);
      return { outcome: 'created' };
    },
  });
}
