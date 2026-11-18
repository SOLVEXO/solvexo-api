import { DraftOrdersService } from './draft-orders.service';

// Guest invoices: a draft with only a typed-in name + email can be invoiced; the customer account is created when they pay.

const chain = (value: unknown) => ({ lean: async () => value, select: () => chain(value) });

function build(draftOverrides: Record<string, unknown> = {}, existingUser: any = null) {
  const draft: any = {
    _id: 'd1', storeId: 's1', sellerId: 'sel1', status: 'open', isPaid: false,
    customerId: null, customerName: 'Uzair', customerEmail: 'Uzair@Example.com', customerPhone: '0331',
    items: [{ name: 'Belt', quantity: 1, unitPrice: 6500, options: [], sku: null, type: 'physical' }],
    subtotal: 6500, discountAmount: 0, shippingAmount: 0, taxAmount: 0, total: 6500, currency: 'PKR', paymentTerms: null, dueDate: null, notes: '',
    ...draftOverrides,
  };
  const users: any[] = existingUser ? [existingUser] : [];
  const metaUpserts: any[] = [];
  const draftUpdates: any[] = [];
  const sent: any[] = [];
  const orders: any[] = [];
  const repos: any = {
    storeModel: {
      findOne: () => chain({ _id: 's1', sellerId: 'sel1', name: 'Amara', defaultLanguage: 'en' }),
      findById: async () => ({ _id: 's1', sellerId: 'sel1', isDelete: false }),
    },
    draftOrderModel: {
      findOne: () => ({ ...chain(draft), then: undefined }),
      updateOne: async (...a: any[]) => { draftUpdates.push(a); return {}; },
    },
    userModel: {
      findOne: async (q: any) => users.find(u => u.storeId === q.storeId && u.email === q.email) ?? null,
      create: async (doc: any) => { const u = { _id: 'u-new', ...doc }; users.push(u); return u; },
    },
    storeCustomerMetaModel: { updateOne: async (...a: any[]) => { metaUpserts.push(a); return {}; } },
    productModel: { find: () => chain([]), updateOne: async () => ({}) },
    orderModel: { create: async (d: any) => { orders.push(d); return { _id: 'o1', ...d }; } },
  };
  const service = new DraftOrdersService(
    { repositories: repos } as any,
    { log: async () => undefined } as any,
    { buildSnapshots: async () => [] } as any,
    { sendMail: async () => true } as any,
    { get: () => undefined } as any,
    {} as any,
    {} as any,
    { sendCustomerEmail: async (args: any) => { sent.push(args); return 'sent'; } } as any,
    { recordSale: async () => undefined } as any,
  );
  // getOwned checks store ownership + loads the draft; the store mock above satisfies both.
  return { service, draft, users, metaUpserts, draftUpdates, sent, orders };
}

describe('guest draft invoices', () => {
  it('sends an invoice to a guest (typed email) — no registered customer needed', async () => {
    const { service, sent, draftUpdates, users } = build();
    const res: any = await service.sendInvoice('s1', 'sel1', 'd1');
    expect(res.success).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe('Uzair@Example.com');
    expect(sent[0].event).toBe('draft_order_invoice');
    expect(draftUpdates.length).toBe(1);
    expect(users.length).toBe(0); // the account is NOT created just by sending
  });

  it('still refuses when there is no email, or the typed email is not valid', async () => {
    await expect(build({ customerEmail: '' }).service.sendInvoice('s1', 'sel1', 'd1')).rejects.toThrow('email');
    await expect(build({ customerEmail: 'not-an-email' }).service.sendInvoice('s1', 'sel1', 'd1')).rejects.toThrow('valid email');
  });

  it('a registered customer is invoiced as before', async () => {
    const { service, sent } = build({ customerId: 'u1', customerEmail: 'a@b.co' });
    await service.sendInvoice('s1', 'sel1', 'd1');
    expect(sent.length).toBe(1);
  });

  it('refuses to invoice a draft that is already marked as paid, and sends nothing', async () => {
    const { service, sent, draftUpdates } = build({ isPaid: true });
    await expect(service.sendInvoice('s1', 'sel1', 'd1')).rejects.toThrow('already marked as paid');
    expect(sent.length).toBe(0);
    expect(draftUpdates.length).toBe(0); // no pay link was created either
  });

  it('the invoice goes out with a PDF branded from the store (logo / colour lookups can fail without stopping it)', async () => {
    const { service, sent } = build();
    (service as any).databaseService.repositories.storeNotificationSettingsModel = { findOne: () => { throw new Error('settings down'); } };
    await service.sendInvoice('s1', 'sel1', 'd1');
    expect(sent.length).toBe(1);
    expect(sent[0].attachments[0].contentType).toBe('application/pdf');
  });

  // Regression: the address pattern once lost its backslashes and rejected every email that contained the letter "s".
  it('accepts ordinary addresses, including ones with the letter s, dots, plus and digits', async () => {
    for (const email of ['uzairhasan.fsd@gmail.com', 'sara@shop.com', 'Mrs.Stone+orders@sales.example.co.uk', 'user_1@s2.pk', 'ali.hassan@solvexo.store']) {
      const { service, sent } = build({ customerEmail: email });
      const res: any = await service.sendInvoice('s1', 'sel1', 'd1');
      expect(res.success).toBe(true);
      expect(sent[0].to).toBe(email);
    }
  });

  it('still rejects things that are not email addresses', async () => {
    for (const email of ['nope', 'a@b', 'a b@c.com', '@c.com', 'a@@c.com', 'a@c.', 'plainly wrong']) {
      await expect(build({ customerEmail: email }).service.sendInvoice('s1', 'sel1', 'd1')).rejects.toThrow('valid email');
    }
  });

  it('a guest with such an address becomes a customer when they pay or when the seller completes the order', async () => {
    const { service, draft, users } = build({ customerEmail: 'Uzairhasan.FSD@gmail.com' });
    expect(await service.ensureCustomerForDraft(draft)).toBe('u-new');
    expect(users[0].email).toBe('uzairhasan.fsd@gmail.com');
  });
});

describe('ensureCustomerForDraft', () => {
  it('creates a store-scoped customer (lower-cased email, no password) and links the draft', async () => {
    const { service, draft, users, metaUpserts, draftUpdates } = build();
    const id = await service.ensureCustomerForDraft(draft);
    expect(id).toBe('u-new');
    expect(draft.customerId).toBe('u-new');
    expect(users.length).toBe(1);
    expect(users[0].email).toBe('uzair@example.com');
    expect(users[0].storeId).toBe('s1');
    expect(users[0].role).toBe('user');
    expect(users[0].name).toBe('Uzair');
    expect(metaUpserts.length).toBe(1);
    expect(draftUpdates[0][1].$set.customerId).toBe('u-new');
  });

  it('reuses this store\'s existing account with that email instead of creating a duplicate', async () => {
    const { service, draft, users } = build({}, { _id: 'u-old', storeId: 's1', email: 'uzair@example.com' });
    const id = await service.ensureCustomerForDraft(draft);
    expect(id).toBe('u-old');
    expect(users.length).toBe(1);
  });

  it('does nothing for a draft that already has a customer', async () => {
    const { service, users } = build({ customerId: 'u9' });
    expect(await service.ensureCustomerForDraft({ customerId: 'u9' })).toBe('u9');
    expect(users.length).toBe(0);
  });

  it('refuses a draft with no usable email', async () => {
    const { service } = build();
    await expect(service.ensureCustomerForDraft({ storeId: 's1', customerEmail: '' })).rejects.toThrow('valid customer email');
  });
});

describe('paying a guest invoice', () => {
  it('creates the customer first, then completes the draft into an order', async () => {
    const { service, users } = build();
    const order: string[] = [];
    // The webhook path: finalizeInvoicePayment loads the draft by id and marks it paid, then completes it.
    (service as any).repos.draftOrderModel.findOne = async () => ({ _id: 'd1', storeId: 's1', sellerId: 'sel1', status: 'open', isPaid: false, customerId: null, customerEmail: 'g@x.co', customerName: 'G' });
    (service as any).complete = async (_s: string, _sel: string, id: string) => { order.push('complete:' + id + ':users=' + users.length); return {}; };
    await service.finalizeInvoicePayment({ id: 'pi_1', metadata: { draftOrderId: 'd1' } });
    expect(order.length).toBe(1);
    expect(order[0]).toBe('complete:d1:users=1'); // the account existed by the time complete() ran
  });
});

describe('completing a guest draft yourself', () => {
  const digital = [{ productId: 'p1', variantId: 'v1', name: 'Ebook', quantity: 1, unitPrice: 500, options: [], sku: null, type: 'digital' }];

  it('creates the customer from the typed email and puts the order under them', async () => {
    const { service, users, orders } = build({ items: digital, subtotal: 500, total: 500 });
    const res: any = await service.complete('s1', 'sel1', 'd1');
    expect(res.orderId).toBe('o1');
    expect(users.length).toBe(1);
    expect(users[0].email).toBe('uzair@example.com');
    expect(orders[0].userId).toBe('u-new');
  });

  it('asks for an email (not a registered customer) when the guest has none', async () => {
    const { service, users } = build({ items: digital, customerEmail: '' });
    await expect(service.complete('s1', 'sel1', 'd1')).rejects.toThrow('email');
    expect(users.length).toBe(0);
  });

  it('a registered customer is completed as before, without creating anyone', async () => {
    const { service, users, orders } = build({ items: digital, customerId: 'u1' });
    await service.complete('s1', 'sel1', 'd1');
    expect(users.length).toBe(0);
    expect(orders[0].userId).toBe('u1');
  });
});
