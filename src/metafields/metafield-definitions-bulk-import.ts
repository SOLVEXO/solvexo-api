/* eslint-disable prettier/prettier */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BulkColumn,
  BulkRowError,
  parseBoolCell,
  parseEnumCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { CreateDefinitionDto } from './dto/create-definition.dto';
import { METAFIELD_OWNER_RESOURCES, METAFIELD_TYPES } from './schemas/metafield-definition.schema';

export const METAFIELD_DEFINITION_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Owner Resource', required: true, description: `What the field attaches to: ${METAFIELD_OWNER_RESOURCES.join(', ')}.`, example: 'product' },
  { key: 'Key', required: true, description: 'Stable identifier: starts with a lowercase letter; only lowercase letters, numbers, - or _ (max 40). Cannot change later.', example: 'fabric' },
  { key: 'Name', required: true, description: 'Label shown to the seller (max 60 characters).', example: 'Fabric' },
  { key: 'Type', required: true, description: `One of: ${METAFIELD_TYPES.join(', ')}.`, example: 'single_line_text_field' },
  { key: 'Description', description: 'Optional, max 200 characters.', example: '' },
  { key: 'Required', description: 'yes or no (default no).', example: 'no' },
  { key: 'Storefront Access', description: 'yes to let the storefront display the values; no keeps them private (default no).', example: 'no' },
];

export const METAFIELD_DEFINITION_IMPORT_MAX_ROWS = 1000;

export interface MetafieldDefinitionImportDeps {
  definitionModel: any;
  /** MetafieldsService-like: createDefinition (the REAL create path). */
  metafieldsService: {
    createDefinition(storeId: string, sellerId: string, dto: any): Promise<any>;
  };
}

export async function importMetafieldDefinitionsCsv(
  deps: MetafieldDefinitionImportDeps,
  sellerId: string,
  storeId: string,
  text: string,
) {
  const { definitionModel, metafieldsService } = deps;
  return runBulkImport({
    text,
    columns: METAFIELD_DEFINITION_IMPORT_COLUMNS,
    maxRows: METAFIELD_DEFINITION_IMPORT_MAX_ROWS,
    label: 'field',
    fileDedupeKey: (r) => (r['Owner Resource'] && r.Key ? `${r['Owner Resource'].toLowerCase()}:${r.Key}` : null),
    handler: async (r) => {
      const ownerResource = parseEnumCell(r['Owner Resource'], 'Owner Resource', METAFIELD_OWNER_RESOURCES);
      if (!ownerResource) throw new BulkRowError('Owner Resource is required');
      const type = parseEnumCell(r.Type, 'Type', METAFIELD_TYPES);
      if (!type) throw new BulkRowError('Type is required');
      if (!r.Key) throw new BulkRowError('Key is required');
      if (!r.Name) throw new BulkRowError('Name is required');
      const required = parseBoolCell(r.Required, 'Required');
      const storefrontAccess = parseBoolCell(r['Storefront Access'], 'Storefront Access');

      // Same rules as the single-create route: validate with the real DTO.
      const dto = plainToInstance(CreateDefinitionDto, {
        ownerResource,
        key: r.Key,
        name: r.Name,
        type,
        ...(r.Description ? { description: r.Description } : {}),
        ...(required !== undefined ? { required } : {}),
        ...(storefrontAccess !== undefined ? { storefrontAccess } : {}),
      });
      const errors = await validate(dto);
      if (errors.length) {
        throw new BulkRowError(errors.flatMap((e) => Object.values(e.constraints ?? {})).join('; '));
      }

      const existing = await definitionModel.findOne({ storeId, ownerResource, namespace: 'custom', key: r.Key });
      if (existing) return { outcome: 'skipped', note: `A "${r.Key}" field already exists for ${ownerResource}s` };

      await metafieldsService.createDefinition(storeId, sellerId, dto);
      return { outcome: 'created' };
    },
  });
}
