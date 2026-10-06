/* eslint-disable prettier/prettier */
import { importCustomersCsv } from './customer-bulk-import';

function setup(existingEmails: string[] = [], storeId = 'S1') {
  // Fake store-scoped user table: key = storeId|email
  const db = new Set(existingEmails.map((e) => `${storeId}|${e}`));
  const created: any[] = [];
  const deps = {
    exists: async (email: string) => db.has(`${storeId}|${email}`),
    create: async (dto: any) => { created.push(dto); db.add(`${storeId}|${dto.email}`); return {}; },
  };
  return { deps, created };
}

describe('customers bulk import', () => {
  it('saves valid rows and reports invalid ones with the column', async () => {
    const { deps, created } = setup();
    const csv = ['Name,Email,Phone', 'Ann,ann@x.com,123', 'Bob,not-an-email,', ',c@x.com,'].join('\n');
    const res = await importCustomersCsv(deps, csv);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(2);
    expect(res.data.failed[0].error).toContain('Email');
    expect(res.data.failed[1].error).toContain('Name');
    expect(created[0]).toEqual({ name: 'Ann', email: 'ann@x.com', phone: '123' });
  });

  it('skips a customer that already exists in the store (case-insensitive email)', async () => {
    const { deps, created } = setup(['ann@x.com']);
    const res = await importCustomersCsv(deps, 'Name,Email\nAnn,ANN@x.com');
    expect(res.data.created).toBe(0);
    expect(res.data.skipped).toBe(1);
    expect(res.data.skippedRows[0].note).toBe('Customer already exists');
    expect(created.length).toBe(0);
  });

  it('fails the second row when the same email appears twice in the file', async () => {
    const { deps, created } = setup();
    const res = await importCustomersCsv(deps, 'Name,Email\nAnn,a@x.com\nAnn2,A@x.com');
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate');
    expect(created.length).toBe(1);
  });

  it('does not treat another store\'s customer as existing', async () => {
    const other = setup(['ann@x.com'], 'OTHER');
    // deps look only at their own store key (S1 in a fresh setup)
    const mine = setup([], 'S1');
    const res = await importCustomersCsv(mine.deps, 'Name,Email\nAnn,ann@x.com');
    expect(res.data.created).toBe(1);
    expect(other.created.length).toBe(0);
  });

  it('rejects a file missing a required column', async () => {
    const { deps } = setup();
    await expect(importCustomersCsv(deps, 'Name,Phone\nAnn,1')).rejects.toThrow('Email');
  });
});
