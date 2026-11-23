/* eslint-disable prettier/prettier */
import { DEFAULT_ACCOUNTS } from './chart.const';
import { encryptCredential } from '../common/credential-encryption.util';
import { cleanBaseUrl, erpnextJournal, odooMove, summarizeByDay, tallyGroup, tallyXml, unmappedAccounts, type IntAccount, type IntEntry } from './integrations.util';
import { AccountingIntegrationsService } from './accounting-integrations.service';

const accounts: IntAccount[] = DEFAULT_ACCOUNTS.map(a => ({ ...a, externalCode: null }));
const acc = (key: string) => accounts.find(a => a.key === key)!;
const sale: IntEntry = {
  id: 'e1', seq: 12, date: '2026-11-20T10:00:00Z', reference: 'INV-000012', memo: 'POS sale INV-000012',
  lines: [{ accountKey: 'cash', debitMinor: 11800, creditMinor: 0 }, { accountKey: 'sales_pos', debitMinor: 0, creditMinor: 10000 }, { accountKey: 'output_tax', debitMinor: 0, creditMinor: 1800 }],
};
const expense: IntEntry = { id: 'e2', seq: 13, date: '2026-11-20T15:00:00Z', reference: 'EXP-1', memo: 'Rent & <utilities>', lines: [{ accountKey: 'exp_rent', debitMinor: 5000, creditMinor: 0 }, { accountKey: 'cash', debitMinor: 0, creditMinor: 5000 }] };

describe('daily summary', () => {
  it('nets each account per day in the store time zone and drops zero lines', () => {
    const late: IntEntry = { ...sale, id: 'e3', seq: 14, date: '2026-11-20T20:30:00Z' }; // 01:30 on the 21st in Karachi
    const days = summarizeByDay([sale, expense, late], 'Asia/Karachi');
    expect(days.map(d => d.id)).toEqual(['day:2026-11-20', 'day:2026-11-21']);
    expect(days[0].lines).toEqual(expect.arrayContaining([{ accountKey: 'cash', debitMinor: 6800, creditMinor: 0 }, { accountKey: 'exp_rent', debitMinor: 5000, creditMinor: 0 }]));
    expect(days[0].lines.reduce((t, l) => t + l.debitMinor - l.creditMinor, 0)).toBe(0);
  });
});

describe('Tally', () => {
  it('puts ledgers under Tally groups', () => {
    expect(tallyGroup(acc('cash'))).toBe('Cash-in-Hand');
    expect(tallyGroup(acc('receivables'))).toBe('Sundry Debtors');
    expect(tallyGroup(acc('output_tax'))).toBe('Duties & Taxes');
    expect(tallyGroup(acc('sales_pos'))).toBe('Sales Accounts');
    expect(tallyGroup(acc('cogs'))).toBe('Direct Expenses');
    expect(tallyGroup(acc('exp_rent'))).toBe('Indirect Expenses');
  });

  it('writes ledger masters and journal vouchers with Tally signs, escaped text and the mapped ledger names', () => {
    const mapped = accounts.map(a => (a.key === 'cash' ? { ...a, externalCode: 'Cash' } : a));
    const x = tallyXml({ company: 'Ali Traders', accounts: mapped, entries: [sale, expense], exponent: 2, tz: 'Asia/Karachi' });
    expect(x).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(x).toContain('<SVCURRENTCOMPANY>Ali Traders</SVCURRENTCOMPANY>');
    expect(x).toContain('<LEDGER NAME="Cash" ACTION="Create"><NAME.LIST><NAME>Cash</NAME></NAME.LIST><PARENT>Cash-in-Hand</PARENT>');
    expect(x).toContain('<VOUCHER REMOTEID="solvexo-e1" VCHTYPE="Journal" ACTION="Create"><DATE>20261120</DATE>');
    expect(x).toContain('<LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-118.00</AMOUNT>');
    expect(x).toContain('<LEDGERNAME>Sales: POS</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100.00</AMOUNT>');
    expect(x).toContain('<NARRATION>Rent &amp; &lt;utilities&gt;</NARRATION>');
    expect(x.match(/<LEDGER NAME=/g)).toHaveLength(4); // only the accounts used
  });
});

describe('Odoo and ERPNext payloads', () => {
  it('an Odoo move in major units with the SOLVEXO reference', () => {
    const m: any = odooMove(sale, k => ({ cash: 1, sales_pos: 2, output_tax: 3 } as any)[k], 9, 2, 'Asia/Karachi');
    expect(m).toMatchObject({ move_type: 'entry', journal_id: 9, date: '2026-11-20', ref: 'SOLVEXO-12' });
    expect(m.line_ids[0]).toEqual([0, 0, expect.objectContaining({ account_id: 1, debit: 118, credit: 0 })]);
  });
  it('an ERPNext journal entry, submitted, with the reference in cheque_no', () => {
    const j: any = erpnextJournal(sale, k => `${k} - ABC`, 'ABC Ltd', 2, 'Asia/Karachi');
    expect(j).toMatchObject({ doctype: 'Journal Entry', company: 'ABC Ltd', posting_date: '2026-11-20', docstatus: 1, cheque_no: 'SOLVEXO-12' });
    expect(j.accounts[2]).toMatchObject({ account: 'output_tax - ABC', debit_in_account_currency: 0, credit_in_account_currency: 18 });
  });
  it('lists accounts without a code in the other app; only https base URLs', () => {
    expect(unmappedAccounts([sale], accounts).map(a => a.key)).toEqual(['cash', 'output_tax', 'sales_pos']);
    expect(cleanBaseUrl('https://acme.odoo.com/')).toBe('https://acme.odoo.com');
    expect(cleanBaseUrl('http://acme.odoo.com')).toBeNull();
    expect(cleanBaseUrl('https://user:pw@acme.com')).toBeNull();
    expect(cleanBaseUrl('not a url')).toBeNull();
  });
});

describe('clients (fake Odoo / ERPNext)', () => {
  beforeAll(() => { process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = 'test-key-for-integrations'; });
  const mapped = accounts.map(a => ({ ...a, externalCode: a.key === 'cash' ? '101001' : a.key === 'sales_pos' ? '400000' : a.key === 'output_tax' ? '251000' : null }));
  const svc = () => {
    const s = new AccountingIntegrationsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    s.checkHost = jest.fn(async () => undefined);
    return s;
  };
  const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  it('Odoo: signs in, finds the journal and accounts, posts once, and reuses an entry already there', async () => {
    const s = svc();
    const calls: any[] = [];
    let existing = false;
    s.fetchFn = jest.fn(async (_url: string, init: any) => {
      const p = JSON.parse(init.body).params; calls.push(p);
      if (p.service === 'common') return ok({ result: 7 });
      const [, , , model, method] = p.args;
      if (model === 'account.journal') return ok({ result: [{ id: 3, name: 'Miscellaneous Operations' }] });
      if (model === 'account.account') return ok({ result: [{ id: 11, code: '101001' }, { id: 12, code: '400000' }, { id: 13, code: '251000' }] });
      if (model === 'account.move' && method === 'search_read') return ok({ result: existing ? [{ id: 55 }] : [] });
      if (model === 'account.move' && method === 'create') return ok({ result: 99 });
      return ok({ result: true });
    }) as any;
    const client: any = await (s as any).client({ app: 'odoo', baseUrl: 'https://acme.odoo.com', database: 'acme', login: 'a@b.c', journalCode: 'MISC', secretEnc: encryptCredential('KEY', 'INTEGRATIONS') });
    expect(await client.check()).toContain('Miscellaneous Operations');
    expect(await client.push(sale, mapped, 2, 'Asia/Karachi')).toBe('99');
    const create = calls.find(c => c.args?.[4] === 'create');
    expect(create.args[5][0].line_ids.map((l: any) => l[2].account_id)).toEqual([11, 12, 13]);
    expect(calls.some(c => c.args?.[4] === 'action_post')).toBe(true);
    existing = true;
    expect(await client.push(sale, mapped, 2, 'Asia/Karachi')).toBe('55');
    expect(s.checkHost).toHaveBeenCalledWith('acme.odoo.com');
  });

  it('Odoo: an unmapped account fails with what to fix', async () => {
    const s = svc();
    s.fetchFn = jest.fn(async (_u: string, init: any) => { const p = JSON.parse(init.body).params; return ok({ result: p.service === 'common' ? 7 : [{ id: 3, name: 'Misc' }] }); }) as any;
    const client: any = await (s as any).client({ app: 'odoo', baseUrl: 'https://acme.odoo.com', database: 'acme', login: 'a', journalCode: 'MISC', secretEnc: encryptCredential('KEY', 'INTEGRATIONS') });
    await expect(client.push(expense, mapped, 2, 'UTC')).rejects.toThrow(/6100 Rent/);
  });

  it('ERPNext: token auth, checks the company, creates a submitted journal entry unless one with the reference exists', async () => {
    const s = svc();
    const seen: Array<{ url: string; init: any }> = [];
    s.fetchFn = jest.fn(async (url: string, init: any) => {
      seen.push({ url, init });
      if (url.includes('get_logged_user')) return ok({ message: 'api@acme.com' });
      if (url.includes('/api/resource/Company/')) return ok({ data: { name: 'ACME Ltd' } });
      if (init.method === 'GET') return ok({ data: [] });
      return ok({ data: { name: 'ACC-JV-2026-00001' } });
    }) as any;
    const erpAccounts = mapped.map(a => (a.externalCode ? { ...a, externalCode: `${a.name} - AC` } : a));
    const client: any = await (s as any).client({ app: 'erpnext', baseUrl: 'https://erp.acme.com', company: 'ACME Ltd', secretEnc: encryptCredential('k1:s1', 'INTEGRATIONS') });
    expect(seen[0].init.headers.Authorization).toBe('token k1:s1');
    expect(await client.check()).toContain('api@acme.com');
    expect(await client.push(sale, erpAccounts, 2, 'Asia/Karachi')).toBe('ACC-JV-2026-00001');
    const post = seen.find(x => x.init.method === 'POST')!;
    expect(JSON.parse(post.init.body)).toMatchObject({ company: 'ACME Ltd', docstatus: 1, cheque_no: 'SOLVEXO-12' });
  });

  it('a refused key is a clear message', async () => {
    const s = svc();
    s.fetchFn = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' })) as any;
    await expect((s as any).client({ app: 'erpnext', baseUrl: 'https://erp.acme.com', company: 'A', secretEnc: encryptCredential('k:s', 'INTEGRATIONS') })).rejects.toThrow(/API key was refused/);
  });
});
