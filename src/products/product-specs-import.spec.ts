/* eslint-disable prettier/prettier */
import { importProductsCsv } from './product-bulk-import';

const chain = (rows: any) => {
  const c: any = {};
  c.select = () => c;
  c.lean = async () => rows;
  c.then = (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
  return c;
};

function setup(existingDefs: any[] = []) {
  const defs: any[] = [...existingDefs];
  const values: any[] = [];
  let seq = 0;
  const deps: any = {
    repos: {
      storeModel: { findOne: async () => ({ _id: 'S1', categoryId: null }) },
      categoryModel: { find: () => chain([{ _id: 'C1', name: 'Clothing' }]) },
      productModel: { find: () => chain([]), findOne: () => chain(null) },
      productVariantModel: { find: () => chain([]), findOne: () => chain(null) },
      metafieldDefinitionModel: {
        find: () => chain(defs),
        create: async (d: any) => { defs.push(d); return d; },
      },
      metafieldValueModel: {
        findOneAndUpdate: async (q: any, u: any) => { values.push({ ...q, value: u.$set.value }); return {}; },
      },
    },
    addPhysicalProduct: async () => { seq++; return { data: { product: { _id: 'NP' + seq }, defaultVariant: { _id: 'NV' + seq } } }; },
    editProduct: async () => ({}),
    updateVariant: async () => ({}),
  };
  return { deps, defs, values };
}

const HEADER = 'Name,Price,SKU,Category,Spec 1 Name,Spec 1 Value,Spec 2 Name,Spec 2 Value';
const run = (deps: any, rows: string[]) => importProductsCsv(deps, 'SEL', 'S1', [HEADER, ...rows].join('\n'));

describe('product specs in CSV import', () => {
  it('creates a shared field for a new name and saves the value for the new product', async () => {
    const { deps, defs, values } = setup();
    const res = await run(deps, ['AC,100,AC-1,clothing,Brand,Ecostar,Capacity,1.0 Ton']);
    expect(res.data.created).toBe(1);
    expect(defs.map((d) => d.name)).toEqual(['Brand', 'Capacity']);
    expect(defs[0].storefrontAccess).toBe(true);
    expect(defs[0].key).toBe('brand');
    expect(values.map((v) => `${v.key}=${v.value}`)).toEqual(['brand=Ecostar', 'capacity=1.0 Ton']);
    expect(values[0].ownerId).toBe('NP1');
  });

  it('reuses an existing field by name (case-insensitive) instead of creating a second one', async () => {
    const { deps, defs, values } = setup([{ key: 'brand', namespace: 'custom', type: 'single_line_text_field', name: 'Brand' }]);
    await run(deps, ['AC,100,AC-1,clothing,brand,Ecostar,,']);
    expect(defs.length).toBe(1);
    expect(values.length).toBe(1);
    expect(values[0].key).toBe('brand');
  });

  it('a Spec name without a value fails that row and creates nothing', async () => {
    const { deps, defs } = setup();
    const res = await run(deps, ['AC,100,AC-1,clothing,Brand,,,']);
    expect(res.data.created).toBe(0);
    expect(res.data.failedCount).toBe(1);
    expect(defs.length).toBe(0);
    expect(res.data.failed[0].error).toContain('Spec 1');
  });

  it('a value that does not fit the field type (number field) fails the row before the product is created', async () => {
    const { deps } = setup([{ key: 'weight', namespace: 'custom', type: 'number_integer', name: 'Weight' }]);
    const res = await run(deps, ['AC,100,AC-1,clothing,Weight,heavy,,']);
    expect(res.data.created).toBe(0);
    expect(res.data.failedCount).toBe(1);
  });

  it('two keys that slug to the same text get distinct keys', async () => {
    const { deps, defs } = setup();
    await run(deps, ['AC,100,AC-1,clothing,Brand!,A,Brand?,B']);
    expect(new Set(defs.map((d) => d.key)).size).toBe(2);
  });
});
