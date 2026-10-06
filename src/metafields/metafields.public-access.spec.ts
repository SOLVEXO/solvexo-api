/* eslint-disable prettier/prettier */
import { MetafieldsService } from './metafields.service';
import { DatabaseService } from '../database/databaseservice';

describe('MetafieldsService.getPublicValues — Storefronts access', () => {
  const defs = [
    { _id: 'd1', storeId: 's', ownerResource: 'product', namespace: 'custom', key: 'fabric', name: 'Fabric', type: 'single_line_text_field', required: false, storefrontAccess: true },
    { _id: 'd2', storeId: 's', ownerResource: 'product', namespace: 'custom', key: 'secret', name: 'Secret', type: 'single_line_text_field', required: false, storefrontAccess: false },
    { _id: 'd3', storeId: 's', ownerResource: 'product', namespace: 'custom', key: 'legacy', name: 'Legacy', type: 'single_line_text_field', required: false },
  ];
  const values = [
    { storeId: 's', ownerResource: 'product', ownerId: 'p', namespace: 'custom', key: 'fabric', value: 'Cotton' },
    { storeId: 's', ownerResource: 'product', ownerId: 'p', namespace: 'custom', key: 'secret', value: 'hidden' },
    { storeId: 's', ownerResource: 'product', ownerId: 'p', namespace: 'custom', key: 'legacy', value: 'old' },
  ];
  let service: MetafieldsService;

  beforeEach(() => {
    const definitionModel = {
      find: jest.fn().mockImplementation((f: any) => ({
        lean: () => Promise.resolve(defs.filter(d => d.storeId === f.storeId && d.ownerResource === f.ownerResource && (f.storefrontAccess === undefined || (d as any).storefrontAccess === f.storefrontAccess))),
      })),
    };
    const valueModel = { find: jest.fn().mockReturnValue({ lean: () => Promise.resolve(values) }) };
    service = new MetafieldsService({ repositories: { metafieldDefinitionModel: definitionModel, metafieldValueModel: valueModel, storeModel: {} } } as unknown as DatabaseService);
  });

  it('public read returns only storefrontAccess=true definitions (legacy/missing is private)', async () => {
    const res = await service.getPublicValues('s', 'product', 'p');
    expect(res.data.map(d => d.key)).toEqual(['fabric']);
    expect(res.data[0].value).toBe('Cotton');
    expect(JSON.stringify(res)).not.toContain('hidden');
    expect(JSON.stringify(res)).not.toContain('old');
  });
});
