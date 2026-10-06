/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const CATEGORY_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Name', required: true, description: 'Category name (max 50 characters). Unique per parent category.', example: 'Summer Collection' },
  { key: 'Parent', description: 'Name of an existing MAIN category (or one listed earlier in this file). Leave blank for a main category. Only one level of nesting is allowed.', example: '' },
  { key: 'Description', description: 'Optional, max 500 characters.', example: 'Light and breezy picks' },
  { key: 'Image URL', description: 'Optional full http(s) link to an image.', example: '' },
  { key: 'Status', description: 'active or inactive (default active).', example: 'active' },
];

export const CATEGORY_IMPORT_MAX_ROWS = 1000;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ciExact = (s: string) => new RegExp(`^${escapeRegex(s)}$`, 'i');

export interface CategoryImportDeps {
  categoryModel: any;
  /** CategoriesService-like: addCategory + updateCategory (the REAL create/update path). */
  categoriesService: {
    addCategory(userId: string, role: string, dto: any): Promise<any>;
    updateCategory(userId: string, storeId: string, categoryId: string, dto: any): Promise<any>;
  };
}

/** Rows are processed strictly in order so a file listing parents first works. */
export async function importCategoriesCsv(deps: CategoryImportDeps, userId: string, storeId: string, text: string) {
  const { categoryModel, categoriesService } = deps;

  return runBulkImport({
    text,
    columns: CATEGORY_IMPORT_COLUMNS,
    maxRows: CATEGORY_IMPORT_MAX_ROWS,
    label: 'categorie', // engine appends "s"
    fileDedupeKey: (r) => (r.Name ? `${r.Parent.toLowerCase()}|${r.Name.toLowerCase()}` : null),
    handler: async (r) => {
      const name = r.Name.trim();
      if (!name) throw new BulkRowError('Name is required');
      if (name.length > 50) throw new BulkRowError('Name cannot be more than 50 characters');
      if (r.Description.length > 500) throw new BulkRowError('Description cannot be more than 500 characters');
      if (r['Image URL']) {
        try {
          const u = new URL(r['Image URL']);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
        } catch {
          throw new BulkRowError('Image URL must be a valid http(s) link');
        }
      }
      const status = parseEnumCell(r.Status, 'Status', ['active', 'inactive'] as const) ?? 'active';

      let parentId: string | null = null;
      if (r.Parent) {
        const parent = await categoryModel.findOne({
          storeId,
          name: ciExact(r.Parent),
          parentId: null,
          status: 'active',
          isDelete: false,
        });
        if (!parent) {
          throw new BulkRowError(
            `Parent "${r.Parent}" was not found as an active main category in this store (create it first or list it earlier in the file)`,
          );
        }
        parentId = String(parent._id);
      }

      const existing = await categoryModel.findOne({ storeId, name: ciExact(name), parentId, isDelete: false });
      if (existing) return { outcome: 'skipped', note: `Category "${name}" already exists${r.Parent ? ` under "${r.Parent}"` : ''}` };

      const created = await categoriesService.addCategory(userId, 'seller', {
        name,
        storeId,
        ...(parentId ? { parentId } : {}),
        ...(r.Description ? { description: r.Description } : {}),
        ...(r['Image URL'] ? { image: r['Image URL'] } : {}),
      });
      if (status === 'inactive') {
        await categoriesService.updateCategory(userId, storeId, String(created.data._id), { isActive: false });
      }
      return { outcome: 'created' };
    },
  });
}
