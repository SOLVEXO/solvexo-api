/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { EmailService } from '../otp/services/email.service';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import { TextGenerationService } from '../ai/text-generation.service';
import { SalesLead, SalesLeadDocument } from './schemas/sales-lead.schema';
import {
  SalesActivity,
  SalesActivityDocument,
} from './schemas/sales-activity.schema';
import {
  SalesSettings,
  SalesSettingsDocument,
} from './schemas/sales-settings.schema';
import {
  SalesChatSession,
  SalesChatSessionDocument,
} from './schemas/sales-chat-session.schema';
import {
  SalesPartner,
  SalesPartnerDocument,
} from './schemas/sales-partner.schema';
import { SOURCE_LABELS } from './sales-ops.constants';
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { bodyToHtml, type SalesActor } from './sales-ops.util';
import {
  type AgentConfig,
  type ChatDetails,
  CHAT_SCHEMA,
  DEFAULT_KNOWLEDGE,
  FIRST_REPLY_SCHEMA,
  type PlanFact,
  canCreateLead,
  chatPrompt,
  firstReplyPrompt,
  mergeDetails,
  plansText,
  systemPrompt,
} from './sales-agent.util';

const MAX_VISITOR_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 1000;
const PKT = 5 * 3_600_000;
const FALLBACK =
  'Sorry, I’m having trouble answering right now. Please leave your name and WhatsApp number and someone from the Solvexo team will contact you.';
const FIRST_REPLY_SOURCES = new Set(['website_form', 'contact_message']);

export interface AgentSettingsInput {
  aiEnabled?: boolean;
  aiFirstReply?: boolean;
  aiChat?: boolean;
  aiWhatsApp?: boolean;
  aiAgentName?: string;
  aiGreeting?: string | null;
  aiKnowledge?: string | null;
  aiRules?: string | null;
  aiSignOff?: string | null;
  aiReplyTo?: string | null;
  aiChatDailyLimit?: number;
}

/**
 * The AI sales agent: a live chat on solvexo.store that answers questions and books demos, and an automatic,
 * personalised first email to new demo requests and Contact Us leads. Everything else it writes (for example a
 * WhatsApp message to a lead with no email) is a draft for a person to send.
 */
@Injectable()
export class SalesAgentService {
  private readonly logger = new Logger(SalesAgentService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly fx: ExchangeRateService,
    private readonly email: EmailService,
    private readonly ai: TextGenerationService,
    private readonly sales: SalesOpsService,
    @Inject(forwardRef(() => SalesCaptureService))
    private readonly capture: SalesCaptureService,
    @InjectModel(SalesLead.name)
    private readonly leads: Model<SalesLeadDocument>,
    @InjectModel(SalesActivity.name)
    private readonly activities: Model<SalesActivityDocument>,
    @InjectModel(SalesSettings.name)
    private readonly settings: Model<SalesSettingsDocument>,
    @InjectModel(SalesChatSession.name)
    private readonly chats: Model<SalesChatSessionDocument>,
    @InjectModel(SalesPartner.name)
    private readonly partners: Model<SalesPartnerDocument>,
  ) {}

  /** Is a real model connected? (AI_PROVIDER=claude with an API key.) The agent never runs on canned text. */
  get connected() {
    return this.ai.providerName === 'claude';
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  async getConfig() {
    const s = await this.load();
    return {
      success: true,
      data: {
        connected: this.connected,
        aiEnabled: !!s.aiEnabled,
        aiFirstReply: s.aiFirstReply !== false,
        aiChat: s.aiChat !== false,
        aiAgentName: s.aiAgentName || 'Sana',
        aiGreeting: s.aiGreeting ?? null,
        aiKnowledge: s.aiKnowledge ?? null,
        defaultKnowledge: DEFAULT_KNOWLEDGE,
        aiRules: s.aiRules ?? null,
        aiSignOff: s.aiSignOff ?? null,
        aiReplyTo: s.aiReplyTo ?? null,
        aiChatDailyLimit: s.aiChatDailyLimit ?? 300,
        chatsToday: await this.chatsToday(),
        aiWhatsApp: s.aiWhatsApp !== false,
      },
    };
  }

  async saveConfig(input: AgentSettingsInput) {
    const set: Record<string, unknown> = {};
    for (const k of [
      'aiEnabled',
      'aiFirstReply',
      'aiChat',
      'aiWhatsApp',
    ] as const)
      if (input[k] !== undefined) set[k] = !!input[k];
    if (set.aiEnabled && !this.connected)
      throw new BadRequestException(
        'The AI is not connected yet: set AI_PROVIDER=claude and ANTHROPIC_API_KEY on the server, then switch it on.',
      );
    if (input.aiAgentName !== undefined) {
      const n = input.aiAgentName?.trim();
      if (!n) throw new BadRequestException('Give the assistant a name.');
      set.aiAgentName = n.slice(0, 40);
    }
    const text = (v: string | null | undefined, max: number) =>
      (v ?? '').trim().slice(0, max) || null;
    if (input.aiGreeting !== undefined)
      set.aiGreeting = text(input.aiGreeting, 300);
    if (input.aiKnowledge !== undefined)
      set.aiKnowledge = text(input.aiKnowledge, 8000);
    if (input.aiRules !== undefined) set.aiRules = text(input.aiRules, 2000);
    if (input.aiSignOff !== undefined)
      set.aiSignOff = text(input.aiSignOff, 200);
    if (input.aiReplyTo !== undefined) {
      const e = text(input.aiReplyTo, 160)?.toLowerCase() ?? null;
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
        throw new BadRequestException('The reply-to email looks wrong.');
      set.aiReplyTo = e;
    }
    if (input.aiChatDailyLimit !== undefined)
      set.aiChatDailyLimit = Math.min(
        5000,
        Math.max(1, Math.round(Number(input.aiChatDailyLimit) || 0)),
      );
    await this.settings.updateOne(
      { key: 'default' },
      { $set: set },
      { upsert: true },
    );
    return this.getConfig();
  }

  /** "Test the assistant" in Super Admin: one chat turn, nothing saved, works even while the agent is switched off. */
  async preview(
    message: string,
    history: { role: 'visitor' | 'agent'; text: string }[] = [],
  ) {
    if (!this.connected)
      throw new BadRequestException(
        'The AI is not connected yet (AI_PROVIDER=claude and ANTHROPIC_API_KEY).',
      );
    const text = message?.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) throw new BadRequestException('Type a message to test.');
    const s = await this.load();
    const turns = [
      ...history.slice(-10).map((h) => ({
        role: h.role,
        text: String(h.text ?? '').slice(0, MAX_MESSAGE_CHARS),
      })),
      { role: 'visitor' as const, text },
    ];
    const out = await this.chatTurn(s, turns, {});
    return { success: true, data: out };
  }

  // ── Website chat (public) ───────────────────────────────────────────────────

  async chatConfig() {
    const s = await this.load();
    const enabled =
      this.chatOn(s) && (await this.chatsToday()) < (s.aiChatDailyLimit ?? 300);
    return {
      success: true,
      data: {
        enabled,
        agentName: s.aiAgentName || 'Sana',
        greeting: this.greeting(s),
        // Solvexo's own WhatsApp Business number, once connected in Sales → WhatsApp (public: it is the sales line).
        whatsappNumber: s.waPhoneNumberId && s.waAccessTokenEnc ? s.waDisplayNumber ?? null : null,
      },
    };
  }

  async startChat(input: {
    page?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    partnerCode?: string | null;
  }) {
    const s = await this.load();
    if (!this.chatOn(s))
      throw new ForbiddenException('Chat is not available right now.');
    if ((await this.chatsToday()) >= (s.aiChatDailyLimit ?? 300))
      throw new ForbiddenException(
        'Chat is busy right now. Please use the Book-a-demo form and the team will call you.',
      );
    const token = randomBytes(24).toString('hex');
    const greeting = this.greeting(s);
    const clean = (v: string | null | undefined, n = 100) =>
      (v ?? '').trim().slice(0, n) || null;
    await this.chats.create({
      token,
      messages: [{ role: 'agent', text: greeting, at: new Date() }],
      details: {},
      page: clean(input.page, 200),
      partnerCode:
        clean(input.partnerCode, 40)
          ?.toUpperCase()
          .replace(/[^A-Z0-9-]/g, '') || null,
      utm:
        input.utmSource || input.utmMedium || input.utmCampaign
          ? {
              source: clean(input.utmSource),
              medium: clean(input.utmMedium),
              campaign: clean(input.utmCampaign),
            }
          : null,
    });
    return {
      success: true,
      data: { token, agentName: s.aiAgentName || 'Sana', greeting },
    };
  }

  async chatMessage(token: string, message: string) {
    const text = message?.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) throw new BadRequestException('Type a message.');
    const session: any =
      typeof token === 'string' && /^[a-f0-9]{48}$/.test(token)
        ? await this.chats.findOne({ token }).lean()
        : null;
    if (!session)
      throw new NotFoundException(
        'This chat has ended. Please start a new one.',
      );
    const s = await this.load();
    if (!this.chatOn(s))
      throw new ForbiddenException('Chat is not available right now.');
    const visitorCount = session.messages.filter(
      (m: any) => m.role === 'visitor',
    ).length;
    const turns = [
      ...session.messages.map((m: any) => ({ role: m.role, text: m.text })),
      { role: 'visitor' as const, text },
    ];

    let reply = FALLBACK;
    let details: ChatDetails = session.details ?? {};
    let wantsDemo = false,
      wantsHuman = false,
      summary = session.summary,
      language = session.language,
      preferredTime = '';
    if (visitorCount >= MAX_VISITOR_MESSAGES) {
      reply =
        'Thanks for chatting! To keep going, please leave your name and WhatsApp number and a person from the team will take it from here.';
      wantsHuman = true;
    } else {
      try {
        const out = await this.chatTurn(s, turns, details);
        reply = out.reply;
        details = out.details;
        wantsDemo = out.wantsDemo;
        wantsHuman = out.wantsHuman;
        summary = out.summary || summary;
        language = out.language || language;
        preferredTime = out.preferredTime;
      } catch (e: any) {
        this.logger.warn(`Sales chat AI failed: ${e?.message}`);
      }
    }

    const now = new Date();
    const set: Record<string, unknown> = { details, summary, language };
    let leadId: string | null = session.leadId ?? null;
    let newLead = false;
    if ((wantsDemo || wantsHuman) && canCreateLead(details)) {
      if (!leadId) {
        const partner: any = session.partnerCode
          ? await this.partners
              .findOne({ code: session.partnerCode })
              .select('_id')
              .lean()
          : null;
        const r = await this.capture.capture({
          name: details.name!,
          email: details.email,
          phone: details.phone,
          businessName: details.businessName,
          city: details.city,
          businessType: details.businessType,
          source: 'website_chat',
          sourceDetail: wantsDemo
            ? 'Booked a demo in chat'
            : 'Asked for a person in chat',
          note: [
            summary,
            preferredTime ? `Best time to call: ${preferredTime}.` : null,
            session.page ? `Chatted on ${session.page}.` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          utm: session.utm,
          partnerId: partner ? String(partner._id) : null,
        });
        leadId = r.leadId;
        newLead = r.created;
        set.leadId = leadId;
        void this.capture.notifyManagers(
          `${wantsHuman ? 'Wants a person' : 'Demo booked'} in website chat: ${details.name}`,
          summary ?? '',
          leadId,
        );
      } else {
        await this.fillLead(leadId, details);
      }
    }
    if (wantsHuman && session.status !== 'handed_over')
      set.status = 'handed_over';
    await this.chats.updateOne({ token }, {
      $set: set,
      $push: {
        messages: {
          $each: [
            { role: 'visitor', text, at: now },
            { role: 'agent', text: reply, at: new Date() },
          ],
        },
      },
    } as any);
    return {
      success: true,
      data: { reply, leadCreated: newLead, handedOver: wantsHuman },
    };
  }

  // ── First reply (automatic) ───────────────────────────────────────────────

  /**
   * A personalised first email to a brand-new lead from the Book-a-demo form or Contact Us, sent automatically
   * within a minute or two. A WhatsApp version is saved on the lead as a draft for a person to send.
   */
  async firstReply(
    leadId: string,
    message?: string | null,
  ): Promise<'sent' | 'drafted' | 'skipped'> {
    const s = await this.load();
    if (!(s.aiEnabled && s.aiFirstReply !== false && this.connected))
      return 'skipped';
    const lead: any = await this.leads.findById(leadId).lean();
    if (!lead || lead.isDelete || !FIRST_REPLY_SOURCES.has(lead.source))
      return 'skipped';
    if (
      await this.activities
        .findOne({ leadId, 'meta.aiFirstReply': true })
        .select('_id')
        .lean()
    )
      return 'skipped';
    const signOff =
      s.aiSignOff?.trim() ||
      `${s.aiAgentName || 'Sana'}, Solvexo's AI assistant\nsolvexo.store`;
    try {
      const out = await this.ai.generate({
        tier: 'standard',
        maxTokens: 1200,
        schema: FIRST_REPLY_SCHEMA,
        system: systemPrompt(this.cfg(s), await this.plans(), 'email'),
        prompt: firstReplyPrompt(
          {
            ...lead,
            sourceLabel:
              SOURCE_LABELS[lead.source as keyof typeof SOURCE_LABELS] ??
              'website',
            message,
          },
          signOff,
        ),
      });
      const j: any = out.json;
      if (!j?.emailBody || !j?.subject) throw new Error('empty answer');
      if (lead.phone && j.whatsappText)
        await this.leads.updateOne(
          { _id: leadId },
          {
            $set: {
              aiDraft: {
                channel: 'whatsapp',
                text: String(j.whatsappText).slice(0, 2000),
                createdAt: new Date(),
              },
            },
          },
        );
      if (!lead.email) {
        await this.sales.log(
          leadId,
          'system',
          'The AI assistant drafted a WhatsApp first message (no email on this lead). Review it on the lead and send it.',
          null,
          { aiFirstReply: true },
        );
        return 'drafted';
      }
      const subject = String(j.subject).slice(0, 150);
      const body = String(j.emailBody).slice(0, 5000);
      const replyTo =
        s.aiReplyTo ||
        (lead.ownerAdminId
          ? (
              (await this.db.repositories.adminModel
                .findById(lead.ownerAdminId)
                .select('email')
                .lean()) as any
            )?.email
          : null) ||
        undefined;
      await this.email.sendMail(
        lead.email,
        subject,
        notificationEmailShell(subject, bodyToHtml(body)),
        replyTo,
      );
      await this.activities.create({
        leadId,
        type: 'email',
        subject,
        body,
        adminId: null,
        meta: { ai: true, aiFirstReply: true },
      });
      await this.leads.updateOne(
        { _id: leadId },
        { $set: { lastActivityAt: new Date() } },
      );
      if (lead.stage === 'new')
        await this.sales.setStage(
          lead,
          'contacted',
          null,
          {},
          'First reply sent by the AI assistant.',
        );
      return 'sent';
    } catch (e: any) {
      this.logger.warn(
        `AI first reply failed for lead ${leadId}: ${e?.message}`,
      );
      await this.sales.log(
        leadId,
        'system',
        'The AI assistant could not write a first reply. Please reply by hand.',
        null,
        { aiFirstReply: false },
      );
      return 'skipped';
    }
  }

  /** "Mark as sent" / "Discard" on the lead's AI draft. */
  async resolveDraft(actor: SalesActor, leadId: string, sent: boolean) {
    const lead: any = (await this.sales.get(actor, leadId)).data.lead;
    if (!lead.aiDraft) return this.sales.get(actor, leadId);
    if (sent)
      await this.sales.addActivity(
        actor,
        leadId,
        lead.aiDraft.channel === 'email' ? 'note' : 'whatsapp',
        lead.aiDraft.text,
        'Sent (AI draft)',
      );
    await this.leads.updateOne({ _id: leadId }, { $set: { aiDraft: null } });
    return this.sales.get(actor, leadId);
  }

  /**
   * A suggested reply to a WhatsApp conversation, for a person to send. Null when the assistant or its WhatsApp
   * drafts are switched off, no AI is connected, or the model fails (the inbox then simply has no draft).
   */
  async draftWhatsApp(
    turns: { role: 'visitor' | 'agent'; text: string }[],
    known: ChatDetails = {},
  ): Promise<string | null> {
    const s = await this.load();
    if (!(s.aiEnabled && s.aiWhatsApp !== false && this.connected)) return null;
    try {
      const out = await this.ai.generate({
        tier: 'standard',
        maxTokens: 700,
        schema: CHAT_SCHEMA,
        system: systemPrompt(this.cfg(s), await this.plans(), 'whatsapp'),
        prompt: chatPrompt(turns, known, 'whatsapp'),
      });
      const reply = (out.json as any)?.reply;
      return typeof reply === 'string' && reply.trim()
        ? reply.trim().slice(0, 1500)
        : null;
    } catch (e: any) {
      this.logger.warn(`AI WhatsApp draft failed: ${e?.message}`);
      return null;
    }
  }

  // ── Transcripts ────────────────────────────────────────────────────────────

  async leadChats(actor: SalesActor, leadId: string) {
    await this.sales.get(actor, leadId); // enforces "reps see only their own leads"
    const rows: any[] = await this.chats
      .find({ leadId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    return { success: true, data: rows.map((c) => this.chatView(c)) };
  }

  async recentChats(limit = 50) {
    const rows: any[] = await this.chats
      .find({ 'messages.1': { $exists: true } })
      .sort({ updatedAt: -1 })
      .limit(Math.min(200, limit))
      .lean();
    return { success: true, data: rows.map((c) => this.chatView(c)) };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async chatTurn(
    s: any,
    turns: { role: 'visitor' | 'agent'; text: string }[],
    known: ChatDetails,
  ) {
    const out = await this.ai.generate({
      tier: 'standard',
      maxTokens: 700,
      schema: CHAT_SCHEMA,
      system: systemPrompt(this.cfg(s), await this.plans(), 'chat'),
      prompt: chatPrompt(turns, known),
    });
    const j: any = out.json;
    if (!j || typeof j.reply !== 'string' || !j.reply.trim())
      throw new Error('empty answer');
    return {
      reply: j.reply.trim().slice(0, 1500),
      language: typeof j.language === 'string' ? j.language : null,
      details: mergeDetails(known, j.details),
      wantsDemo: !!j.wantsDemo,
      wantsHuman: !!j.wantsHuman,
      preferredTime:
        typeof j.preferredTime === 'string'
          ? j.preferredTime.slice(0, 120)
          : '',
      summary: typeof j.summary === 'string' ? j.summary.slice(0, 300) : '',
    };
  }

  private async fillLead(leadId: string, d: ChatDetails) {
    const lead: any = await this.leads.findById(leadId).lean();
    if (!lead) return;
    const set: Record<string, unknown> = {};
    for (const k of [
      'email',
      'phone',
      'businessName',
      'city',
      'businessType',
    ] as const)
      if (d[k] && !lead[k]) set[k] = d[k];
    if (set.phone)
      set.phoneKey = String(set.phone).replace(/\D/g, '').slice(-10);
    if (Object.keys(set).length)
      await this.leads.updateOne({ _id: leadId }, { $set: set });
  }

  private chatView(c: any) {
    return {
      _id: String(c._id),
      leadId: c.leadId ?? null,
      status: c.status,
      summary: c.summary ?? null,
      language: c.language ?? null,
      details: c.details ?? {},
      page: c.page ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: (c.messages ?? []).map((m: any) => ({
        role: m.role,
        text: m.text,
        at: m.at,
      })),
    };
  }

  private async plans(): Promise<string> {
    const r = this.db.repositories;
    const [rows, rate]: [any[], any] = await Promise.all([
      r.platformPlanModel
        .find({
          isPubliclyVisible: true,
          status: 'active',
          isDelete: { $ne: true },
        })
        .sort({ sortOrder: 1 })
        .lean(),
      this.fx.getCurrentRate('PKR').catch(() => null),
    ]);
    const facts: PlanFact[] = rows.map((p) => ({
      name: p.name,
      description: p.description ?? null,
      isFree: !!p.isFree,
      isCustomPricing: !!p.isCustomPricing,
      monthlyPriceUSD: p.monthlyPriceUSD ?? null,
      yearlyPriceUSD: p.yearlyPriceUSD ?? null,
      trialDays: p.trialDays ?? 0,
      featureBullets: p.featureBullets ?? [],
    }));
    return plansText(facts, rate?.ratePerUSD ?? null);
  }

  private cfg(s: any): AgentConfig {
    return {
      agentName: s.aiAgentName || 'Sana',
      knowledge: s.aiKnowledge ?? null,
      rules: s.aiRules ?? null,
      signOff: s.aiSignOff ?? null,
    };
  }

  private greeting(s: any) {
    return (
      s.aiGreeting?.trim() ||
      `Hi! I’m ${s.aiAgentName || 'Sana'}, Solvexo’s AI assistant. Ask me anything about opening your online store, or I can book you a free demo. (Urdu bhi chalegi!)`
    );
  }

  private chatOn(s: any) {
    return !!s.aiEnabled && s.aiChat !== false && this.connected;
  }

  private async chatsToday() {
    const today = new Date(Date.now() + PKT).toISOString().slice(0, 10);
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - PKT);
    return this.chats.countDocuments({ createdAt: { $gte: start } });
  }

  private async load(): Promise<any> {
    return (await this.settings.findOne({ key: 'default' }).lean()) ?? {};
  }
}
