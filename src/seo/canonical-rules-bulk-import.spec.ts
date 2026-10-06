/* eslint-disable prettier/prettier */
import { ConflictException, BadRequestException } from '@nestjs/common';
import { runBulkImport } from '../common/bulk-import/bulk-import.util';
import { CANONICAL_COLUMNS, canonicalFileDedupeKey, makeCanonicalRowHandler } from './canonical-rules-bulk-import';

describe('canonical rules bulk import', () => {
  it('creates, skips existing (Conflict), and reports invalid rows', async () => {
    const created: any[] = [];
    const handler = makeCanonicalRowHandler(async (dto) => {
      if (dto.pathPattern === '/exists') throw new ConflictException('exists');
      if (dto.canonicalUrl.includes('internal')) throw new BadRequestException('Unsafe destination');
      created.push(dto);
    });
    const res: any = await runBulkImport({
      text: 'Path pattern,Canonical URL,Active\n/a,https://x.com/a,no\n/exists,https://x.com/e,\nnoslash,https://x.com,\n/b,ftp://x,\n/c,https://internal.test,\n/a,https://x.com/z,\n',
      columns: CANONICAL_COLUMNS, maxRows: 50, label: 'canonical rule', handler, fileDedupeKey: canonicalFileDedupeKey,
    });
    expect(res.data.created).toBe(1);
    expect(res.data.skipped).toBe(1);
    expect(res.data.failedCount).toBe(4);
    expect(created[0]).toEqual({ pathPattern: '/a', canonicalUrl: 'https://x.com/a', isActive: false });
    const errs = res.data.failed.map((f: any) => f.error).join('|');
    expect(errs).toContain('must start with "/"');
    expect(errs).toContain('Unsafe destination');
    expect(errs).toContain('Duplicate of row');
  });

  it('rejects a file missing a required column', async () => {
    await expect(runBulkImport({ text: 'Path pattern\n/a\n', columns: CANONICAL_COLUMNS, maxRows: 5, label: 'x', handler: async () => ({ outcome: 'created' }) })).rejects.toThrow();
  });
});
