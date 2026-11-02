/* eslint-disable prettier/prettier */
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { SalesAgentService } from './sales-agent.service';
import { salesActor } from './sales-ops.util';
import { model } from './sales-ops.fakes.testspec';

const SUPER = salesActor({ userId: 'a'.repeat(24) });
const REP = salesActor({
  userId: 'b'.repeat(24),
  teamAdmin: true,
  permissions: ['sales.access'],
});
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(
  opts: {
    provider?: 'claude' | 'mock';
    settings?: Record<string, unknown>;
  } = {},
) {
  const repos: any = {
    adminModel: model([
      {
        _id: SUPER.adminId,
        name: 'Atiq',
        email: 'atiq@solvexo.example',
        isSuperAdmin: true,
        status: 'active',
      },
      {
        _id: REP.adminId,
        name: 'Bilal',
        email: 'bilal@solvexo.example',
        roleId: 'r1',
        status: 'active',
      },
    ]),
    adminRoleModel: model([
      { _id: 'r1', isDelete: false, permissions: ['sales.access'] },
    ]),
    sellerModel: model([]),
    storeModel: model([]),
    sellerPlatformSubscriptionModel: model([]),
    platformPlanModel: model([
      {
        _id: 'p1',
        name: 'Starter',
        isPubliclyVisible: true,
        status: 'active',
        isDelete: false,
        sortOrder: 1,
        monthlyPriceUSD: 9,
        yearlyPriceUSD: 90,
        trialDays: 14,
        featureBullets: [],
      },
    ]),
  };
  const db = { repositories: repos } as any;
  const leads = model(),
    activities = model(),
    tasks = model(),
    templates = model(),
    contacts = model();
  const settings = model(
    opts.settings ? [{ key: 'default', ...opts.settings }] : [],
  );
  const chats = model(),
    partners = model();
  const email = { sendMail: jest.fn(async () => true) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const redis = {
    withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const ai = { providerName: opts.provider ?? 'claude', generate: jest.fn() };
  const fx = { getCurrentRate: jest.fn(async () => ({ ratePerUSD: 280 })) };
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
    undefined,
    partners as any,
  );
  const agent = new SalesAgentService(
    db,
    fx as any,
    email as any,
    ai as any,
    sales,
    capture,
    leads as any,
    activities as any,
    settings as any,
    chats as any,
    partners as any,
  );
  (capture as any).agent = agent;
  return {
    agent,
    capture,
    sales,
    leads,
    activities,
    settings,
    chats,
    email,
    notifications,
    ai,
  };
}
const ON = {
  aiEnabled: true,
  aiFirstReply: true,
  aiChat: true,
  aiAgentName: 'Sana',
};

describe('SalesAgentService', () => {
  it('will not switch on without a real AI connected', async () => {
    const { agent } = setup({ provider: 'mock' });
    await expect(agent.saveConfig({ aiEnabled: true })).rejects.toThrow(
      'not connected',
    );
    expect((await agent.chatConfig()).data.enabled).toBe(false);
  });

  it('chats on the website, books a demo into the pipeline, and keeps the transcript', async () => {
    const { agent, ai, leads, chats, notifications } = setup({ settings: ON });
    const started = await agent.startChat({
      page: '/pricing',
      utmCampaign: 'eid-sale',
    });
    expect(started.data.greeting).toContain('Sana');

    ai.generate.mockResolvedValueOnce({
      json: {
        reply:
          'Starter is $9 a month with a 14-day free trial. Want a free demo?',
        language: 'en',
        details: {
          name: '',
          phone: '',
          email: '',
          businessName: '',
          city: '',
          businessType: '',
        },
        wantsDemo: false,
        wantsHuman: false,
        preferredTime: '',
        summary: 'Asking about price',
      },
    });
    const r1 = await agent.chatMessage(started.data.token, 'How much is it?');
    expect(r1.data).toMatchObject({
      reply: expect.stringContaining('$9'),
      leadCreated: false,
    });
    // The model gets the live plans and the rules.
    expect(ai.generate.mock.calls[0][0].system).toContain(
      '- Starter: $9 (about PKR 2520) a month',
    );
    expect(ai.generate.mock.calls[0][0].prompt).toContain(
      'VISITOR: How much is it?',
    );

    ai.generate.mockResolvedValueOnce({
      json: {
        reply: 'Shukriya Sara! Team aap ko kal WhatsApp karegi.',
        language: 'roman_ur',
        details: {
          name: 'Sara Malik',
          phone: '0300 1112223',
          email: '',
          businessName: 'Sara Boutique',
          city: 'Lahore',
          businessType: 'Clothing',
        },
        wantsDemo: true,
        wantsHuman: false,
        preferredTime: 'evening',
        summary: 'Sells clothes on Instagram, wants a demo',
      },
    });
    const r2 = await agent.chatMessage(
      started.data.token,
      'Haan demo chahiye. Sara Malik, 0300 1112223, Sara Boutique Lahore',
    );
    expect(r2.data.leadCreated).toBe(true);
    expect(leads.rows[0]).toMatchObject({
      name: 'Sara Malik',
      phoneKey: '3001112223',
      source: 'website_chat',
      utm: { campaign: 'eid-sale' },
    });
    expect(chats.rows[0].messages.map((m: any) => m.role)).toEqual([
      'agent',
      'visitor',
      'agent',
      'visitor',
      'agent',
    ]);
    await flush();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Demo booked in website chat: Sara Malik',
      }),
    );

    ai.generate.mockResolvedValueOnce({
      json: {
        reply: 'Got it!',
        language: 'en',
        details: {
          name: 'Sara Malik',
          phone: '0300 1112223',
          email: 'sara@boutique.example',
          businessName: '',
          city: '',
          businessType: '',
        },
        wantsDemo: true,
        wantsHuman: false,
        preferredTime: '',
        summary: '',
      },
    });
    await agent.chatMessage(
      started.data.token,
      'my email is sara@boutique.example',
    );
    expect(leads.rows).toHaveLength(1);
    expect(leads.rows[0].email).toBe('sara@boutique.example');
  });

  it('falls back to a safe message when the AI fails', async () => {
    const { agent, ai } = setup({ settings: ON });
    const s = await agent.startChat({});
    ai.generate.mockRejectedValueOnce(new Error('overloaded'));
    expect(
      (await agent.chatMessage(s.data.token, 'hello')).data.reply,
    ).toContain('leave your name and WhatsApp number');
    await expect(agent.chatMessage('f'.repeat(48), 'hi')).rejects.toThrow(
      'This chat has ended',
    );
  });

  it('emails a personalised first reply to a new demo request instead of the standard acknowledgement, and drafts the WhatsApp', async () => {
    const { capture, ai, email, leads, activities } = setup({ settings: ON });
    ai.generate.mockResolvedValueOnce({
      json: {
        subject: 'Your Solvexo demo, Sara',
        emailBody: 'Hi Sara,\n\nYes, Cash on Delivery is supported...\n\nSana',
        whatsappText: 'Assalam o Alaikum Sara! ...',
        language: 'en',
      },
    });
    await capture.demoRequest({
      name: 'Sara',
      phone: '03001112223',
      email: 'sara@x.com',
      message: 'Do you support COD?',
    });
    await flush();
    await flush();
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    expect(email.sendMail).toHaveBeenCalledWith(
      'sara@x.com',
      'Your Solvexo demo, Sara',
      expect.stringContaining('Cash on Delivery is supported'),
      undefined,
    );
    expect(ai.generate.mock.calls[0][0].prompt).toContain(
      'Do you support COD?',
    );
    expect(leads.rows[0]).toMatchObject({
      stage: 'contacted',
      aiDraft: { channel: 'whatsapp', text: 'Assalam o Alaikum Sara! ...' },
    });
    expect(activities.rows.find((a: any) => a.type === 'email')).toMatchObject({
      meta: { ai: true, aiFirstReply: true },
      adminId: null,
    });
  });

  it('only drafts when there is no email, and sends the standard acknowledgement when the AI is off', async () => {
    const a = setup({ settings: ON });
    a.ai.generate.mockResolvedValueOnce({
      json: {
        subject: 's',
        emailBody: 'b',
        whatsappText: 'WhatsApp draft',
        language: 'en',
      },
    });
    await a.capture.demoRequest({ name: 'Usman', phone: '03211234567' });
    await flush();
    await flush();
    expect(a.email.sendMail).not.toHaveBeenCalled();
    expect(a.leads.rows[0]).toMatchObject({
      stage: 'new',
      aiDraft: { text: 'WhatsApp draft' },
    });

    const b = setup({ settings: { ...ON, aiEnabled: false } });
    await b.capture.demoRequest({
      name: 'Sara',
      phone: '03001112223',
      email: 'sara@x.com',
    });
    await flush();
    await flush();
    expect(b.ai.generate).not.toHaveBeenCalled();
    expect(b.email.sendMail).toHaveBeenCalledWith(
      'sara@x.com',
      expect.stringContaining('We got your demo request'),
      expect.any(String),
    );
  });

  it('lets the owner send or discard the draft, and keeps transcripts to people who may see the lead', async () => {
    const { agent, sales, leads, activities } = setup({ settings: ON });
    const { data } = await sales.create(SUPER, {
      name: 'Hamza',
      phone: '03215550000',
    });
    leads.rows[0].aiDraft = {
      channel: 'whatsapp',
      text: 'Hi Hamza!',
      createdAt: new Date(),
    };
    const r = await agent.resolveDraft(SUPER, data.lead._id, true);
    expect(r.data.lead.aiDraft).toBeNull();
    expect(
      activities.rows.find((a: any) => a.type === 'whatsapp'),
    ).toMatchObject({ body: 'Hi Hamza!', outcome: 'Sent (AI draft)' });
    await expect(agent.leadChats(REP, data.lead._id)).rejects.toThrow(
      'Lead not found',
    );
  });
});
