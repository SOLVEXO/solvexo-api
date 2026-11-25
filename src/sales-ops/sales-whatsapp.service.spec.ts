/* eslint-disable prettier/prettier */
process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY =
  process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY ||
  'test-key-for-sales-whatsapp-spec-0123456789';
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { SalesWhatsAppService } from './sales-whatsapp.service';
import { salesActor } from './sales-ops.util';
import { model } from './sales-ops.fakes.testspec';

const SUPER = salesActor({ userId: 'a'.repeat(24) });
const REP = salesActor({
  userId: 'b'.repeat(24),
  teamAdmin: true,
  permissions: ['sales.access'],
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const NUMBER = '1234567890';

function setup() {
  const repos: any = {
    adminModel: model([
      {
        _id: SUPER.adminId,
        name: 'Atiq',
        isSuperAdmin: true,
        status: 'active',
      },
      { _id: REP.adminId, name: 'Bilal', roleId: 'r1', status: 'active' },
    ]),
    adminRoleModel: model([
      { _id: 'r1', isDelete: false, permissions: ['sales.access'] },
    ]),
    sellerModel: model([]),
    storeModel: model([]),
    sellerPlatformSubscriptionModel: model([]),
  };
  const db = { repositories: repos } as any;
  const leads = model(),
    activities = model(),
    tasks = model(),
    templates = model(),
    contacts = model();
  const settings = model(),
    conversations = model(),
    messages = model();
  const redis = {
    withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const email = { sendMail: jest.fn(async () => true) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const agent = {
    draftWhatsApp: jest.fn(
      async () => 'Ji, COD available hai! Demo ke liye kab call karein?',
    ),
  };
  const sales = new SalesOpsService(
    db,
    redis as any,
    email as any,
    leads as any,
    activities as any,
    tasks as any,
    templates as any,
  );
  const capture = new SalesCaptureService(
    db,
    redis as any,
    email as any,
    notifications as any,
    { stuck: async () => [] } as any,
    sales,
    leads as any,
    activities as any,
    contacts as any,
  );
  const wa = new SalesWhatsAppService(
    notifications as any,
    sales,
    capture,
    agent as any,
    leads as any,
    settings as any,
    conversations as any,
    messages as any,
  );
  const calls: { url: string; body: any }[] = [];
  let reply: (url: string) => { status?: number; json: any } = (url) =>
    url.includes('/messages')
      ? { json: { messages: [{ id: `wamid.out${calls.length}` }] } }
      : url.includes('subscribed_apps')
        ? { json: { success: true } }
        : url.includes('/debug_token')
          ? { json: { data: { granular_scopes: [
              { scope: 'whatsapp_business_messaging', target_ids: ['70001', '70002'] },
              { scope: 'whatsapp_business_management', target_ids: ['70002'] },
            ] } } }
          : url.includes('/70001/phone_numbers')
            ? { json: { data: [{ id: '5550001' }] } }
            : url.includes('/70002/phone_numbers')
              ? { json: { data: [{ id: NUMBER }] } }
              : url.includes('whatsapp_business_account')
                // Real Meta: a phone number has no such field.
                ? { status: 400, json: { error: { code: 100, message: '(#100) Tried accessing nonexisting field (whatsapp_business_account)' } } }
                : {
                    json: {
                      id: NUMBER,
                      display_phone_number: '+92 300 0000000',
                      verified_name: 'Solvexo',
                    },
                  };
  wa.fetchImpl = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : null,
    });
    const r = reply(String(url));
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.json,
    } as any;
  }) as any;
  return {
    wa,
    sales,
    leads,
    activities,
    settings,
    conversations,
    messages,
    agent,
    notifications,
    calls,
    setReply: (f: typeof reply) => {
      reply = f;
    },
  };
}

const inbound = (
  id: string,
  text: string,
  at = Math.floor(Date.now() / 1000),
  from = '923001112223',
) => ({
  phoneNumberId: NUMBER,
  payload: {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: NUMBER },
              contacts: [{ wa_id: from, profile: { name: 'Sara Malik' } }],
              messages: [
                {
                  id,
                  from,
                  timestamp: String(at),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  },
});

describe('SalesWhatsAppService', () => {
  it('connects Solvexo’s number after Meta confirms it, keeps the token encrypted, and subscribes the app', async () => {
    const { wa, settings, calls } = setup();
    await expect(wa.connect({ phoneNumberId: 'abc' })).rejects.toThrow(
      'Phone number ID',
    );
    await expect(wa.connect({ phoneNumberId: NUMBER })).rejects.toThrow(
      'access token',
    );
    const r = await wa.connect({
      phoneNumberId: NUMBER,
      accessToken: 'EAAG-secret-token-123456',
      templateName: 'sales_followup',
      templateUsesName: true,
    });
    expect(r.data).toMatchObject({
      connected: true,
      displayNumber: '+92 300 0000000',
      wabaId: '70002',
      templateName: 'sales_followup',
      webhookUrl: expect.stringContaining('/webhooks/whatsapp'),
    });
    expect(r.data.tokenHint).not.toContain('secret');
    expect(settings.rows[0].waAccessTokenEnc).not.toContain('EAAG');
    // Finds the account that owns the number among the ones the token was granted, then subscribes the app to it.
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining(`/${NUMBER}?fields=id,display_phone_number,verified_name`),
      expect.stringContaining('/debug_token?input_token='),
      expect.stringContaining('/70001/phone_numbers'),
      expect.stringContaining('/70002/phone_numbers'),
      expect.stringContaining('/70002/subscribed_apps'),
    ]);
    expect(calls[0].url).not.toContain('whatsapp_business_account');
  });

  it("asks Meta which accounts the token reaches with the app's own token, and names them when none has the number", async () => {
    const { wa, calls, setReply } = setup();
    process.env.META_APP_ID = '111'; process.env.META_APP_SECRET = 'app-secret';
    const seen: string[] = [];
    const fetchBefore = wa.fetchImpl;
    wa.fetchImpl = (async (url: any, init: any) => { if (String(url).includes('/debug_token')) seen.push(init?.headers?.Authorization); return fetchBefore(url, init); }) as any;
    try {
      const r = await wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890' });
      expect(r.data.wabaId).toBe('70002');
      expect(seen).toEqual(['Bearer 111|app-secret']);
      setReply((url) => url.includes('/debug_token')
        ? { json: { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['70001'] }] } } }
        : url.includes('/70001/phone_numbers') ? { json: { data: [{ id: '5550001' }] } }
          : { json: { id: NUMBER, display_phone_number: '+92 300 0000000', verified_name: 'Solvexo' } });
      await expect(wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890' }))
        .rejects.toThrow(`This token can reach WhatsApp Business Account 70001, but none lists number ${NUMBER}`);
      setReply((url) => url.includes('/debug_token') ? { json: { data: { granular_scopes: [] } } }
        : { json: { id: NUMBER, display_phone_number: '+92 300 0000000', verified_name: 'Solvexo' } });
      await expect(wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890' }))
        .rejects.toThrow('This token has no WhatsApp Business Account assigned');
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      delete process.env.META_APP_ID; delete process.env.META_APP_SECRET;
    }
  });

  it('uses a WhatsApp Business Account ID the admin types, and refuses one that does not own the number', async () => {
    const { wa, calls, setReply } = setup();
    const r = await wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: ' 70002 ' });
    expect(r.data.wabaId).toBe('70002');
    expect(calls.some((c) => c.url.includes('/debug_token'))).toBe(false);
    // A typed account that owns another number: the token's own accounts find the right one.
    expect((await wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: '70001' })).data.wabaId).toBe('70002');
    await expect(wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: 'abc' }))
      .rejects.toThrow('digits only');
    // A typed ID that does not own the number: the token's own accounts are tried before giving up.
    calls.length = 0;
    setReply((url) => url.includes('/debug_token')
      ? { json: { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['70002'] }] } } }
      : url.includes('/99999/phone_numbers')
        ? { status: 400, json: { error: { message: '(#100) Unsupported get request' } } }
        : url.includes('/70002/phone_numbers') ? { json: { data: [{ id: NUMBER }] } }
          : url.includes('subscribed_apps') ? { json: { success: true } }
            : { json: { id: NUMBER, display_phone_number: '+92 300 0000000', verified_name: 'Solvexo' } });
    const r2 = await wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: '99999' });
    expect(r2.data.wabaId).toBe('70002');
    setReply((url) => url.includes('/debug_token') ? { json: { data: { granular_scopes: [] } } }
      : url.includes('/70001/phone_numbers') ? { json: { data: [{ id: '5550001', display_phone_number: '+92 300 1111111' }] } }
        : { json: { id: NUMBER, display_phone_number: '+92 300 0000000', verified_name: 'Solvexo' } });
    await expect(wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: '70001' }))
      .rejects.toThrow('WhatsApp Business Account 70001 lists +92 300 1111111 (ID 5550001), not ID 1234567890');
    setReply((url) => url.includes('/debug_token') ? { json: { data: { granular_scopes: [] } } }
      : url.includes('/99999/phone_numbers') ? { status: 400, json: { error: { message: '(#100) Unsupported get request' } } }
        : { json: { id: NUMBER, display_phone_number: '+92 300 0000000', verified_name: 'Solvexo' } });
    await expect(wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: '99999' }))
      .rejects.toThrow('Meta refused to list the numbers of WhatsApp Business Account 99999: (#100) Unsupported get request');
  });

  it('asks for the account ID when the token does not reveal it, and stops when Meta refuses the subscription', async () => {
    const { wa, settings, setReply } = setup();
    setReply((url) => url.includes('/debug_token')
      ? { status: 400, json: { error: { message: 'Not allowed' } } }
      : { json: { id: NUMBER, display_phone_number: '+92 300 0000000', verified_name: 'Solvexo' } });
    await expect(wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890' }))
      .rejects.toThrow('Meta did not say which WhatsApp Business Accounts this token can reach (Not allowed)');
    setReply((url) => url.includes('subscribed_apps')
      ? { status: 403, json: { error: { message: 'Permissions error' } } }
      : url.includes('/phone_numbers')
        ? { json: { data: [{ id: NUMBER }] } }
        : { json: { id: NUMBER, display_phone_number: '+92 300 0000000', verified_name: 'Solvexo' } });
    await expect(wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: '70002' }))
      .rejects.toThrow("Meta did not let the app receive this number's messages: Permissions error");
    expect(settings.rows[0]?.waAccessTokenEnc ?? null).toBeNull();
  });

  it('turns an incoming message into a conversation and a lead, once, with an AI draft for a person to send', async () => {
    const { wa, leads, conversations, messages, agent } = setup();
    await wa.connect({ phoneNumberId: NUMBER, accessToken: 'tok-1234567890' });
    await wa.onWebhook({
      phoneNumberId: '999',
      payload: inbound('wamid.x', 'other number').payload,
    });
    expect(conversations.rows).toHaveLength(0);

    await wa.onWebhook(inbound('wamid.1', 'COD hai?'));
    await wa.onWebhook(inbound('wamid.1', 'COD hai?')); // Meta retries
    await flush();
    expect(messages.rows).toHaveLength(1);
    expect(leads.rows[0]).toMatchObject({
      name: 'Sara Malik',
      phone: '+923001112223',
      phoneKey: '3001112223',
      source: 'whatsapp',
    });
    expect(conversations.rows[0]).toMatchObject({
      waId: '923001112223',
      leadId: String(leads.rows[0]._id),
      unread: 1,
      aiDraft: { text: expect.stringContaining('COD available') },
    });
    expect(agent.draftWhatsApp).toHaveBeenCalledWith(
      [{ role: 'visitor', text: 'COD hai?' }],
      expect.objectContaining({ name: 'Sara Malik' }),
    );
  });

  it('sends a reply inside the 24-hour window, logs it on the lead, and offers only the template after it', async () => {
    const { wa, conversations, messages, activities, leads, calls } = setup();
    await wa.connect({
      phoneNumberId: NUMBER,
      accessToken: 'tok-1234567890',
      templateName: 'sales_followup',
      templateUsesName: true,
    });
    await wa.onWebhook(inbound('wamid.1', 'Price?'));
    await flush();
    const id = String(conversations.rows[0]._id);
    const r = await wa.send(SUPER, id, 'Starter is $9 a month.', true);
    expect(calls.at(-1)!.body).toMatchObject({
      to: '923001112223',
      type: 'text',
      text: { body: 'Starter is $9 a month.' },
    });
    expect(r.data.messages.map((m: any) => [m.direction, m.status])).toEqual([
      ['in', 'received'],
      ['out', 'sent'],
    ]);
    expect(r.data.aiDraft).toBeNull();
    expect(
      activities.rows.find((a: any) => a.type === 'whatsapp' && a.outcome),
    ).toMatchObject({
      body: 'Starter is $9 a month.',
      outcome: 'Sent (AI draft)',
    });
    expect(leads.rows[0].stage).toBe('contacted');

    // Delivery receipts move forward only.
    const outId = messages.rows.find(
      (m: any) => m.direction === 'out',
    ).waMessageId;
    const status = (st: string) => ({
      phoneNumberId: NUMBER,
      payload: {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: NUMBER },
                  statuses: [{ id: outId, status: st }],
                },
              },
            ],
          },
        ],
      },
    });
    await wa.onWebhook(status('read'));
    await wa.onWebhook(status('delivered'));
    expect(messages.rows.find((m: any) => m.waMessageId === outId).status).toBe(
      'read',
    );

    conversations.rows[0].lastInboundAt = new Date(Date.now() - 25 * 3_600_000);
    await expect(wa.send(SUPER, id, 'Hello again')).rejects.toThrow(
      'approved template',
    );
    await wa.sendTemplate(SUPER, id);
    expect(calls.at(-1)!.body).toMatchObject({
      type: 'template',
      template: {
        name: 'sales_followup',
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Sara' }] },
        ],
      },
    });
  });

  it('saves several templates after Meta confirms each, and a rep sends the one they pick', async () => {
    const { wa, conversations, settings, calls, setReply } = setup();
    await wa.connect({ phoneNumberId: NUMBER, accessToken: 'EAAG-tok-1234567890', wabaId: '70002' });
    await wa.onWebhook(inbound('wamid.1', 'Hi'));
    await flush();
    const id = String(conversations.rows[0]._id);
    const meta: Record<string, any[]> = {
      sales_follow_up: [
        { name: 'sales_follow_up', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, following up from Solvexo.' }] },
        { name: 'sales_follow_up', language: 'ur', status: 'APPROVED', components: [{ type: 'BODY', text: 'السلام علیکم {{1}}' }] },
      ],
      demo_reminder: [{ name: 'demo_reminder', language: 'en', status: 'PENDING', components: [{ type: 'BODY', text: 'Your demo is tomorrow.' }] }],
      order_update: [{ name: 'order_update', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Order {{1}} is {{2}}' }] }],
    };
    const base = (url: string) => url.includes('/messages') ? { json: { messages: [{ id: 'wamid.out' }] } } : { json: { id: NUMBER } };
    setReply((url) => {
      const m = url.match(/message_templates\?name=([a-z_]+)/);
      return m ? { json: { data: meta[m[1]] ?? [] } } : base(url);
    });

    await expect(wa.saveTemplates([{ name: 'demo_reminder', lang: 'en' }])).rejects.toThrow('is pending; only approved templates');
    await expect(wa.saveTemplates([{ name: 'sales_follow_up', lang: 'en_US' }])).rejects.toThrow('has no en_US version in WhatsApp Manager (it has: en, ur)');
    await expect(wa.saveTemplates([{ name: 'nope', lang: 'en' }])).rejects.toThrow('There is no template named nope');
    await expect(wa.saveTemplates([{ name: 'order_update', lang: 'en' }])).rejects.toThrow("can't be sent from Solvexo");
    await expect(wa.saveTemplates([{ name: 'Sales Follow', lang: 'en' }])).rejects.toThrow('is not a template name');
    await expect(wa.saveTemplates([{ name: 'a', lang: 'en' }, { name: 'a', lang: 'en' }])).rejects.toThrow('listed twice');

    const before = calls.length;
    const r = await wa.saveTemplates([
      { label: 'Follow-up (English)', name: 'sales_follow_up', lang: 'en' },
      { label: '', name: 'sales_follow_up', lang: 'ur' },
    ]);
    expect(r.data.templates).toEqual([
      { key: 'sales_follow_up:en', label: 'Follow-up (English)', name: 'sales_follow_up', lang: 'en', usesName: true, body: 'Hi {{1}}, following up from Solvexo.' },
      { key: 'sales_follow_up:ur', label: 'sales_follow_up (ur)', name: 'sales_follow_up', lang: 'ur', usesName: true, body: 'السلام علیکم {{1}}' },
    ]);
    // One lookup per template name, however many languages are picked.
    expect(calls.slice(before).filter((c) => c.url.includes('/70002/message_templates?name=sales_follow_up'))).toHaveLength(1);
    expect(settings.rows[0]).toMatchObject({ waTemplateName: 'sales_follow_up', waTemplateLang: 'en' });

    const conv = (await wa.getConversation(SUPER, id)).data;
    expect(conv.templates.map((t: any) => t.key)).toEqual(['sales_follow_up:en', 'sales_follow_up:ur']);
    conversations.rows[0].lastInboundAt = new Date(Date.now() - 25 * 3_600_000);
    const after = await wa.sendTemplate(SUPER, id, 'sales_follow_up:ur');
    expect(calls.at(-1)!.body).toMatchObject({ type: 'template', template: { name: 'sales_follow_up', language: { code: 'ur' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sara' }] }] } });
    // The chat shows what the person received.
    expect(after.data.messages.at(-1)!.text).toBe('السلام علیکم Sara');
    await expect(wa.sendTemplate(SUPER, id, 'gone:en')).rejects.toThrow('no longer in the list');

    expect((await wa.saveTemplates([])).data.templates).toEqual([]);
    await expect(wa.sendTemplate(SUPER, id)).rejects.toThrow('Add an approved template');
  });

  it('shows a rep only conversations with their own leads, and reports a refused send', async () => {
    const { wa, conversations, leads, setReply } = setup();
    await wa.connect({ phoneNumberId: NUMBER, accessToken: 'tok-1234567890' });
    await wa.onWebhook(inbound('wamid.1', 'Hi'));
    await flush();
    const id = String(conversations.rows[0]._id);
    expect((await wa.listConversations(REP)).data).toEqual([]);
    await expect(wa.getConversation(REP, id)).rejects.toThrow(
      'Conversation not found',
    );
    leads.rows[0].ownerAdminId = REP.adminId;
    expect(
      (await wa.listConversations(REP)).data.map((c: any) => c.name),
    ).toEqual(['Sara Malik']);

    setReply(() => ({
      status: 400,
      json: {
        error: { message: 'Recipient phone number not in allowed list' },
      },
    }));
    await expect(wa.send(REP, id, 'Hello')).rejects.toThrow(
      'Recipient phone number not in allowed list',
    );
  });
});
