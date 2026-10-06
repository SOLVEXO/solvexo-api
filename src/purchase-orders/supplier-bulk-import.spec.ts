/* eslint-disable prettier/prettier */
import { importSuppliersCsv } from './supplier-bulk-import';

function setup(existing: { name: string; email?: string }[] = []) {
  const created: any[] = [];
  const deps = {
    listExisting: async () => existing,
    create: async (dto: any) => { created.push(dto); return {}; },
  };
  return { deps, created };
}

describe('suppliers bulk import', () => {
  it('saves valid rows and reports invalid ones with the column', async () => {
    const { deps, created } = setup();
    const csv = ['Name,Email,Phone', 'Acme,orders@acme.com,1', ',x@y.com,', 'Beta,not-mail,'].join('\n');
    const res = await importSuppliersCsv(deps, csv);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(2);
    expect(res.data.failed[0].error).toContain('Name');
    expect(res.data.failed[1].error).toContain('Email');
    expect(created[0]).toMatchObject({ name: 'Acme', email: 'orders@acme.com', phone: '1' });
  });

  it('skips an existing supplier by name (case-insensitive)', async () => {
    const { deps, created } = setup([{ name: 'Acme' }]);
    const res = await importSuppliersCsv(deps, 'Name,Email\nACME,new@acme.com');
    expect(res.data.skipped).toBe(1);
    expect(created.length).toBe(0);
  });

  it('skips an existing supplier by email', async () => {
    const { deps, created } = setup([{ name: 'Other', email: 'orders@acme.com' }]);
    const res = await importSuppliersCsv(deps, 'Name,Email\nAcme,ORDERS@acme.com');
    expect(res.data.skipped).toBe(1);
    expect(res.data.skippedRows[0].note).toContain('email');
    expect(created.length).toBe(0);
  });

  it('fails a repeated name inside the same file', async () => {
    const { deps, created } = setup();
    const res = await importSuppliersCsv(deps, 'Name\nAcme\nacme');
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(created.length).toBe(1);
  });

  it('only sees the suppliers the caller listed (store scoping is the caller\'s listExisting)', async () => {
    const { deps, created } = setup([]); // other store's "Acme" is not listed
    const res = await importSuppliersCsv(deps, 'Name\nAcme');
    expect(res.data.created).toBe(1);
    expect(created.length).toBe(1);
  });

  it('requires the Name column', async () => {
    const { deps } = setup();
    await expect(importSuppliersCsv(deps, 'Email\na@b.com')).rejects.toThrow('Name');
  });
});
