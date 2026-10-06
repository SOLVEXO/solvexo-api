/* eslint-disable prettier/prettier */
import { ConflictException, BadRequestException } from '@nestjs/common';
import { importSeoRedirectsCsv, SEO_REDIRECT_IMPORT_COLUMNS } from './seo-redirects-bulk-import';

// Mimics SeoRedirectsService.create: per-scope unique source, safe destination.
function fakeScope() {
  const rows = new Map<string, any>();
  return {
    rows,
    create: async (dto: any) => {
      if (!dto.destination.startsWith('/') && !dto.destination.startsWith('https://solvexo.store')) {
        throw new BadRequestException('Destination must be a relative path (starting with "/") or a valid absolute URL.');
      }
      if (rows.has(dto.source)) throw new ConflictException('exists');
      rows.set(dto.source, dto);
    },
  };
}

const HEADER = 'Source Path,Destination,Status Code,Active';

describe('seo redirects bulk import', () => {
  it('creates valid rows and reports invalid ones with the column name', async () => {
    const s = fakeScope();
    const csv = [HEADER, '/a,/b,301,yes', '/c,/d,307,yes', 'noslash,/e,,', '/f,https://evil.com/x,,'].join('\n');
    const res = await importSeoRedirectsCsv({ create: s.create }, csv);
    expect(res.data.created).toBe(2);
    expect(res.data.failedCount).toBe(2);
    expect(res.data.failed[0].error).toContain('Status Code');
    expect(res.data.failed[1].error).toContain('Solvexo');
    expect(s.rows.has('/noslash')).toBe(false);
  });

  it('normalises a missing leading slash on the source', async () => {
    const s = fakeScope();
    await importSeoRedirectsCsv({ create: s.create }, [HEADER, 'old,/new,,'].join('\n'));
    expect(s.rows.has('/old')).toBe(true);
  });

  it('skips a source that already exists in the scope and does not create a duplicate', async () => {
    const s = fakeScope();
    s.rows.set('/a', { source: '/a' });
    const res = await importSeoRedirectsCsv({ create: s.create }, [HEADER, '/a,/b,,', '/z,/y,,'].join('\n'));
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    expect(s.rows.size).toBe(2);
  });

  it('fails the second row when the same source appears twice in the file', async () => {
    const s = fakeScope();
    const res = await importSeoRedirectsCsv({ create: s.create }, [HEADER, '/a,/b,,', '/a,/c,,'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate');
  });

  it('rejects a self redirect and a missing required column', async () => {
    const s = fakeScope();
    const res = await importSeoRedirectsCsv({ create: s.create }, [HEADER, '/a,/a,,'].join('\n'));
    expect(res.data.failedCount).toBe(1);
    await expect(importSeoRedirectsCsv({ create: s.create }, 'Destination\n/x')).rejects.toThrow('Source Path');
  });

  it('keeps scopes separate (a platform row does not block a store row)', async () => {
    const platform = fakeScope();
    const store = fakeScope();
    platform.rows.set('/a', {});
    const res = await importSeoRedirectsCsv({ create: store.create }, [HEADER, '/a,/b,,'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(SEO_REDIRECT_IMPORT_COLUMNS.length).toBe(4);
  });
});
