/* eslint-disable prettier/prettier */
import { SalesOpsService } from './sales-ops.service';
import { salesActor } from './sales-ops.util';

/** A tiny in-memory stand-in for a Mongoose model, enough for the queries Sales Ops runs. */
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, '0');
function matches(doc: any, f: any): boolean {
  return Object.entries(f ?? {}).every(([k, v]: [string, any]) => {
    if (k === '$or') return v.some((x: any) => matches(doc, x));
    const d = doc[k];
    if (v instanceof RegExp) return typeof d === 'string' && v.test(d);
    if (
      v &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      !Array.isArray(v)
    ) {
      return Object.entries(v).every(([op, x]: [string, any]) => {
        if (op === '$in')
          return (
            x.map(String).includes(String(d)) ||
            (Array.isArray(d) && d.some((e: any) => x.includes(e)))
          );
        if (op === '$ne')
          return x === null
            ? d !== null && d !== undefined
            : String(d) !== String(x);
        if (op === '$lt') return d != null && d < x;
        if (op === '$lte') return d != null && d <= x;
        if (op === '$gte') return d != null && d >= x;
        if (op === '$exists') return (d !== undefined) === x;
        return false;
      });
    }
    if (v === null) return d === null || d === undefined;
    return String(d) === String(v);
  });
}
function model(rows: any[] = []) {
  // A chainable query: sort() really sorts, the rest pass through; `one` returns the first hit.
  const q = (list: any[], one = false) => {
    let out = list;
    const p: any = {
      then: (ok: any, bad: any) =>
        Promise.resolve(one ? (out[0] ?? null) : out).then(ok, bad),
    };
    for (const m of ['select', 'skip', 'limit', 'lean']) p[m] = () => p;
    p.sort = (s: Record<string, number>) => {
      const [[k, dir]] = Object.entries(s);
      out = [...out].sort((a, b) =>
        a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0,
      );
      return p;
    };
    return p;
  };
  return {
    rows,
    find: jest.fn((f?: any) =>
      q(rows.filter((r) => matches(r, f)).map((r) => ({ ...r }))),
    ),
    findOne: jest.fn((f?: any) =>
      q(
        rows.filter((r) => matches(r, f)),
        true,
      ),
    ),
    findById: jest.fn((id: string) =>
      q(
        rows.filter((r) => String(r._id) === String(id)),
        true,
      ),
    ),
    countDocuments: jest.fn(
      async (f?: any) => rows.filter((r) => matches(r, f)).length,
    ),
    create: jest.fn(async (doc: any) => {
      const r = { _id: oid(), createdAt: new Date(), isDelete: false, ...doc };
      rows.push(r);
      return r;
    }),
    insertMany: jest.fn(async (docs: any[]) =>
      docs.forEach((d) => rows.push({ _id: oid(), isDelete: false, ...d })),
    ),
    updateOne: jest.fn(async (f: any, u: any) => {
      const r = rows.find((x) => matches(x, f));
      if (r) Object.assign(r, u.$set);
      return { matchedCount: r ? 1 : 0 };
    }),
    deleteOne: jest.fn(async (f: any) => {
      const i = rows.findIndex((x) => matches(x, f));
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

const SUPER = salesActor({ userId: 'a'.repeat(24) });
const REP = salesActor({
  userId: 'b'.repeat(24),
  teamAdmin: true,
  permissions: ['sales.access'],
});

function setup(extra: { sellers?: any[]; stores?: any[]; subs?: any[] } = {}) {
  const repos: any = {
    adminModel: model([
      { _id: SUPER.adminId, name: 'Atiq', email: 'atiq@solvexo.example' },
      { _id: REP.adminId, name: 'Bilal', email: 'bilal@solvexo.example' },
    ]),
    adminRoleModel: model([]),
    sellerModel: model(extra.sellers ?? []),
    storeModel: model(extra.stores ?? []),
    sellerPlatformSubscriptionModel: model(extra.subs ?? []),
  };
  const leads = model(),
    activities = model(),
    tasks = model(),
    templates = model();
  const email = { sendMail: jest.fn(async () => true) };
  const redis = {
    withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const svc = new SalesOpsService(
    { repositories: repos } as any,
    redis as any,
    email as any,
    leads as any,
    activities as any,
    tasks as any,
    templates as any,
  );
  return { svc, leads, activities, tasks, email, repos };
}

describe('SalesOpsService', () => {
  it('gives a rep only their own leads, and a manager everything', async () => {
    const { svc } = setup();
    await svc.create(SUPER, {
      name: 'Sara Malik',
      email: 'sara@example.com',
      ownerAdminId: null,
    });
    const mine = await svc.create(REP, {
      name: 'Hamza Mart',
      phone: '0300-1112223',
      ownerAdminId: SUPER.adminId,
    });
    expect(mine.data.lead.ownerAdminId).toBe(REP.adminId); // a rep can't hand a lead to someone else
    expect(
      (await svc.list(REP, {})).data.items.map((l: any) => l.name),
    ).toEqual(['Hamza Mart']);
    expect((await svc.list(SUPER, {})).data.total).toBe(2);
    const saraId = (await svc.list(SUPER, { owner: 'unassigned' })).data
      .items[0]._id;
    await expect(svc.get(REP, saraId)).rejects.toThrow('Lead not found.');
    await expect(
      svc.update(REP, mine.data.lead._id, { ownerAdminId: SUPER.adminId }),
    ).rejects.toThrow('Only a sales manager');
  });

  it('refuses a duplicate email or phone, and a lead with no way to reach them', async () => {
    const { svc } = setup();
    await svc.create(SUPER, {
      name: 'Sara',
      email: 'Sara@Example.com',
      phone: '+92 300 1112223',
    });
    await expect(
      svc.create(SUPER, { name: 'Sara again', phone: '0300 111 2223' }),
    ).rejects.toThrow('already exists');
    await expect(svc.create(SUPER, { name: 'Nobody' })).rejects.toThrow(
      'email or a phone',
    );
  });

  it('moves a New lead to Contacted on first contact, and asks why when a lead is lost', async () => {
    const { svc, email } = setup();
    const { data } = await svc.create(REP, {
      name: 'Sara Malik',
      businessName: 'Sara Boutique',
      email: 'sara@example.com',
    });
    const after = await svc.sendEmail(
      REP,
      data.lead._id,
      'Hello {{name}}',
      'Hi {{name}} from {{businessName}}, {{senderName}} here.',
    );
    expect(email.sendMail).toHaveBeenCalledWith(
      'sara@example.com',
      'Hello Sara Malik',
      expect.stringContaining('Sara Boutique, Bilal here.'),
      'bilal@solvexo.example',
    );
    expect(after.data.lead.stage).toBe('contacted');
    expect(after.data.activities.map((a: any) => a.type)).toEqual(
      expect.arrayContaining(['email', 'stage_change']),
    );
    await expect(svc.changeStage(REP, data.lead._id, 'lost')).rejects.toThrow(
      'why the lead was lost',
    );
    expect(
      (await svc.changeStage(REP, data.lead._id, 'lost', 'price')).data.lead,
    ).toMatchObject({ stage: 'lost', lostReason: 'price' });
  });

  it('keeps the next follow-up date in step with open tasks', async () => {
    const { svc } = setup();
    const { data } = await svc.create(SUPER, {
      name: 'Sara',
      email: 'sara@example.com',
    });
    await svc.createTask(
      SUPER,
      data.lead._id,
      'Call back',
      '2026-11-05T10:00:00.000Z',
    );
    const two = await svc.createTask(
      SUPER,
      data.lead._id,
      'Send pricing',
      '2026-11-03T10:00:00.000Z',
    );
    expect(new Date(two.data.lead.nextFollowUpAt).toISOString()).toBe(
      '2026-11-03T10:00:00.000Z',
    );
    const early = two.data.tasks.find((t: any) => t.title === 'Send pricing');
    await svc.updateTask(SUPER, early._id, { done: true });
    expect(
      new Date(
        (await svc.get(SUPER, data.lead._id)).data.lead.nextFollowUpAt,
      ).toISOString(),
    ).toBe('2026-11-05T10:00:00.000Z');
    expect(
      (await svc.listTasks(SUPER, {})).data.map((t: any) => t.title),
    ).toEqual(['Call back']);
  });

  it('links a lead to the merchant who signs up with that phone, then moves it to Trial and Won', async () => {
    const seller = {
      _id: 'c'.repeat(24),
      name: 'Hamza',
      email: 'hamza@shop.example',
      phone: '+92 300-111 2223',
      isDelete: false,
    };
    const store = {
      _id: 'd'.repeat(24),
      sellerId: seller._id,
      name: 'Hamza Mart',
      slug: 'hamza-mart',
      isDelete: false,
    };
    const sub = {
      _id: 'e'.repeat(24),
      storeId: store._id,
      status: 'trialing',
      amountUSD: 0,
      isDelete: false,
    };
    const { svc, repos } = setup({
      sellers: [seller],
      stores: [store],
      subs: [sub],
    });
    const { data } = await svc.create(SUPER, {
      name: 'Hamza',
      phone: '03001112223',
    });
    expect(data.lead).toMatchObject({ sellerId: seller._id, stage: 'trial' });
    expect(data.merchant).toMatchObject({
      name: 'Hamza',
      state: 'trial',
      stores: [{ name: 'Hamza Mart' }],
    });
    repos.sellerPlatformSubscriptionModel.rows[0] = {
      ...sub,
      status: 'active',
      amountUSD: 10,
    };
    await svc.linkJob();
    const won = await svc.get(SUPER, data.lead._id);
    expect(won.data.lead.stage).toBe('won');
    expect(won.data.lead.wonAt).toBeTruthy();
  });

  it('creates the starter email templates once', async () => {
    const { svc } = setup();
    expect((await svc.listTemplates()).data.map((t: any) => t.name)).toEqual([
      'First follow-up',
      'Demo confirmation',
      'Trial check-in',
    ]);
    expect((await svc.listTemplates()).data).toHaveLength(3);
  });
});
