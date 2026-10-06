/* eslint-disable prettier/prettier */
import { ConflictException } from '@nestjs/common';
import {
  BulkColumn,
  BulkRowError,
  parseBoolCell,
  runBulkImport,
} from '@/common/bulk-import/bulk-import.util';
import { CreateRedirectDto } from '../dto/create-redirect.dto';

export const SEO_REDIRECT_IMPORT_MAX_ROWS = 1000;

export const SEO_REDIRECT_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Source Path', required: true, description: 'The old path to redirect from, starting with / (e.g. /old-page). One redirect per source path.', example: '/old-page' },
  { key: 'Destination', required: true, description: 'Where it should go: a path starting with / or an absolute https:// URL on a Solvexo domain.', example: '/new-page' },
  { key: 'Status Code', description: '301 (permanent) or 302 (temporary). Blank = 301.', example: '301' },
  { key: 'Active', description: 'yes or no. Blank = yes.', example: 'yes' },
];

const norm = (s: string) => {
  const t = s.trim();
  return t.startsWith('/') ? t : `/${t}`;
};

export interface SeoRedirectImportDeps {
  /** `SeoRedirectsService.create` bound to the scope (store id, or null = platform) and actor. */
  create: (dto: CreateRedirectDto) => Promise<unknown>;
}

export function importSeoRedirectsCsv(deps: SeoRedirectImportDeps, text: string) {
  return runBulkImport({
    text,
    columns: SEO_REDIRECT_IMPORT_COLUMNS,
    maxRows: SEO_REDIRECT_IMPORT_MAX_ROWS,
    label: 'redirect',
    fileDedupeKey: (r) => (r['Source Path'] ? norm(r['Source Path']).toLowerCase() : null),
    handler: async (r) => {
      const rawSource = r['Source Path'];
      if (!rawSource) throw new BulkRowError('Source Path is required');
      if (/\s/.test(rawSource) || rawSource.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(rawSource)) {
        throw new BulkRowError('Source Path must be a path on your store such as /old-page (no spaces, no domain)');
      }
      const source = norm(rawSource);
      const destination = r['Destination'];
      if (!destination) throw new BulkRowError('Destination is required');
      if (destination === source) throw new BulkRowError('Destination must differ from Source Path (a page cannot redirect to itself)');

      let statusCode: number | undefined;
      if (r['Status Code'] !== '') {
        const n = Number(r['Status Code']);
        if (n !== 301 && n !== 302) throw new BulkRowError('Status Code must be 301 or 302');
        statusCode = n;
      }
      const isActive = parseBoolCell(r['Active'], 'Active');

      const dto = new CreateRedirectDto();
      dto.source = source;
      dto.destination = destination;
      if (statusCode !== undefined) dto.statusCode = statusCode;
      if (isActive !== undefined) dto.isActive = isActive;
      try {
        await deps.create(dto);
      } catch (err) {
        // The real service refuses a second redirect for the same source in the same scope.
        if (err instanceof ConflictException) return { outcome: 'skipped', note: `A redirect for ${source} already exists` };
        throw err;
      }
      return { outcome: 'created' };
    },
  });
}
