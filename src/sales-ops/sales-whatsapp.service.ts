/* eslint-disable prettier/prettier */
import { SalesAccessService } from './sales-access.service';
import { asReason } from './sales-ops.constants';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { API_PUBLIC_ORIGIN } from '../common/api-origin';
import {
  decryptCredential,
  encryptCredential,
  maskSecret,
} from '../common/credential-encryption.util';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { SalesLead, SalesLeadDocument } from './schemas/sales-lead.schema';
import {
  SalesSettings,
  SalesSettingsDocument,
} from './schemas/sales-settings.schema';
import {
  SalesWaConversation,
  SalesWaConversationDocument,
} from './schemas/sales-wa-conversation.schema';
import {
  SalesWaMessage,
  SalesWaMessageDocument,
} from './schemas/sales-wa-message.schema';
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { SalesAgentService } from './sales-agent.service';
import { type SalesActor } from './sales-ops.util';
import {
  type InboundMessage,
  nextStatus,
  parseWebhook,
  toWaId,
  windowOpen,
  MAX_WA_TEMPLATES,
  WA_TEMPLATE_LANG_RE,
  WA_TEMPLATE_NAME_RE,
  checkMetaTemplate,
  templatesOf,
  waTemplateKey,
  type WaTemplate,
} from './sales-whatsapp.util';

const GRAPH = 'https://graph.facebook.com/v21.0';
const isId = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);

export interface WaConnectInput {
  phoneNumberId: string;
  accessToken?: string;
  templateName?: string | null;
  templateLang?: string;
  templateUsesName?: boolean;
  /** Optional: the WhatsApp Business Account the number belongs to. Found from the token when left empty. */
  wabaId?: string | null;
}

/**
 * Solvexo's own WhatsApp Business number in Sales Ops.
 *
 * Incoming: Meta posts to the platform's existing WhatsApp webhook (webhooks/whatsapp, signature-checked with the
 * app secret); that controller emits `whatsapp.webhook`, and events for the sales number land here. Each person
 * gets a conversation linked to a lead (created on their first message), and the AI assistant drafts a reply.
 *
 * Outgoing: always a person pressing Send. Free text within 24 hours of the person's last message; after that only
 * the approved template (Meta's rule).
 */
@Injectable()
export class SalesWhatsAppService {
  private readonly logger = new Logger(SalesWhatsAppService.name);
  /** Swappable in tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly sales: SalesOpsService,
    private readonly capture: SalesCaptureService,
    private readonly agent: SalesAgentService,
    @InjectModel(SalesLead.name)
    private readonly leads: Model<SalesLeadDocument>,
    @InjectModel(SalesSettings.name)
    private readonly settings: Model<SalesSettingsDocument>,
    @InjectModel(SalesWaConversation.name)
    private readonly conversations: Model<SalesWaConversationDocument>,
    @InjectModel(SalesWaMessage.name)
    private readonly messages: Model<SalesWaMessageDocument>,
  ) {}

  // ── Connection (managers) ──────────────────────────────────────────────────

  async getConnection() {
    const s = await this.load();
    let tokenHint: string | null = null;
    try {
      tokenHint = s.waAccessTokenEnc
        ? maskSecret(decryptCredential(s.waAccessTokenEnc, 'INTEGRATIONS'))
        : null;
    } catch {
      tokenHint = '(cannot be read: re-enter it)';
    }
    return {
      success: true,
      data: {
        connected: !!(s.waPhoneNumberId && s.waAccessTokenEnc),
        phoneNumberId: s.waPhoneNumberId ?? null,
        wabaId: s.waWabaId ?? null,
        displayNumber: s.waDisplayNumber ?? null,
        verifiedName: s.waVerifiedName ?? null,
        tokenHint,
        templateName: s.waTemplateName ?? null,
        templateLang: s.waTemplateLang || 'en',
        templateUsesName: !!s.waTemplateUsesName,
        templates: templatesOf(s),
        connectedAt: s.waConnectedAt ?? null,
        lastEventAt: s.waLastEventAt ?? null,
        webhookUrl: `${API_PUBLIC_ORIGIN}/webhooks/whatsapp`,
        aiDrafts: s.aiWhatsApp !== false,
      },
    };
  }

  /** Checks the token can use the number, subscribes the app to its messages, and saves (token encrypted). */
  async connect(input: WaConnectInput) {
    const s = await this.load();
    const phoneNumberId = input.phoneNumberId?.trim();
    if (!/^\d{5,30}$/.test(phoneNumberId ?? ''))
      throw new BadRequestException(
        'Enter the Phone number ID from Meta (digits only).',
      );
    let token = input.accessToken?.trim() || null;
    if (!token && s.waAccessTokenEnc && s.waPhoneNumberId === phoneNumberId)
      token = decryptCredential(s.waAccessTokenEnc, 'INTEGRATIONS');
    if (!token)
      throw new BadRequestException(
        'Paste the permanent access token (System User token) from Meta.',
      );

    // A phone number has no field for its WhatsApp Business Account (asking for one fails with #100), so only
    // ask for what it has; the account is found separately below.
    const info = await this.graph(
      'GET',
      `/${phoneNumberId}?fields=id,display_phone_number,verified_name`,
      token,
    );
    if (!info.ok || info.data?.id !== phoneNumberId)
      throw new BadRequestException(
        `Meta did not accept this number and token: ${info.error ?? 'check both and try again'}.`,
      );
    const givenWaba = input.wabaId?.trim() || null;
    if (givenWaba && !/^\d{5,30}$/.test(givenWaba))
      throw new BadRequestException(
        'The WhatsApp Business Account ID is digits only.',
      );
    const { wabaId, detail } = await this.findWabaId(
      phoneNumberId,
      token,
      givenWaba ?? (s.waPhoneNumberId === phoneNumberId ? s.waWabaId : null),
    );
    if (!wabaId)
      throw new BadRequestException(
        detail
          ? `${detail}. Copy the WhatsApp Business Account ID from your Meta app → WhatsApp → API Setup (shown under the phone number), or leave it empty, and check the system user has full control of that WhatsApp account.`
          : 'Could not find which WhatsApp Business Account this number belongs to. Copy the WhatsApp Business Account ID from your Meta app → WhatsApp → API Setup (shown under the phone number) and try again.',
      );
    // Without this subscription Meta sends the number's messages to no app, so a failure stops the connect.
    const sub = await this.graph('POST', `/${wabaId}/subscribed_apps`, token);
    if (!sub.ok)
      throw new BadRequestException(
        `Meta did not let the app receive this number's messages: ${sub.error}. Check that the system user has full control of the WhatsApp account and the app.`,
      );
    const lang =
      (input.templateLang ?? s.waTemplateLang ?? 'en').trim().slice(0, 10) ||
      'en';
    await this.settings.updateOne(
      { key: 'default' },
      {
        $set: {
          waPhoneNumberId: phoneNumberId,
          waWabaId: wabaId,
          waDisplayNumber: info.data?.display_phone_number ?? null,
          waVerifiedName: info.data?.verified_name ?? null,
          waAccessTokenEnc: encryptCredential(token, 'INTEGRATIONS'),
          waConnectedAt: new Date(),
          ...(input.templateName !== undefined
            ? {
                waTemplateName:
                  input.templateName?.trim().slice(0, 100) || null,
              }
            : {}),
          waTemplateLang: lang,
          ...(input.templateUsesName !== undefined
            ? { waTemplateUsesName: !!input.templateUsesName }
            : {}),
        },
      },
      { upsert: true },
    );
    return this.getConnection();
  }

  async disconnect() {
    await this.settings.updateOne(
      { key: 'default' },
      {
        $set: {
          waPhoneNumberId: null,
          waWabaId: null,
          waAccessTokenEnc: null,
          waDisplayNumber: null,
          waVerifiedName: null,
          waConnectedAt: null,
        },
      },
    );
    return this.getConnection();
  }

  // ── Incoming (webhook) ───────────────────────────────────────────────────

  @OnEvent('whatsapp.webhook', { async: true })
  async onWebhook(evt: { phoneNumberId: string | null; payload: unknown }) {
    try {
      const s = await this.load();
      if (!s.waPhoneNumberId || evt.phoneNumberId !== s.waPhoneNumberId) return;
      const { messages, statuses } = parseWebhook(
        evt.payload,
        s.waPhoneNumberId,
      );
      if (!messages.length && !statuses.length) return;
      await this.settings.updateOne(
        { key: 'default' },
        { $set: { waLastEventAt: new Date() } },
      );
      for (const m of messages) await this.receive(m);
      for (const st of statuses) {
        const msg: any = await this.messages
          .findOne({ waMessageId: st.waMessageId })
          .select('status')
          .lean();
        if (!msg) continue;
        const status = nextStatus(msg.status, st.status);
        if (status !== msg.status)
          await this.messages.updateOne(
            { _id: msg._id },
            {
              $set: {
                status,
                ...(st.status === 'failed' ? { error: st.error } : {}),
              },
            },
          );
      }
    } catch (e: any) {
      this.logger.error(`Sales WhatsApp webhook failed: ${e?.message}`);
    }
  }

  /** One incoming message: store it once, link the person to a lead, log it, tell the owner, draft a reply. */
  async receive(m: InboundMessage) {
    if (
      await this.messages
        .findOne({ waMessageId: m.waMessageId })
        .select('_id')
        .lean()
    )
      return; // Meta retries
    let convo: any = await this.conversations.findOne({ waId: m.from }).lean();
    if (!convo) {
      try {
        convo = await this.conversations.create({
          waId: m.from,
          profileName: m.name,
          unread: 0,
        });
      } catch {
        convo = await this.conversations.findOne({ waId: m.from }).lean();
      }
    }
    const convoId = String(convo._id);
    try {
      await this.messages.create({
        conversationId: convoId,
        direction: 'in',
        waMessageId: m.waMessageId,
        type: m.type,
        text: m.text,
        status: 'received',
        at: m.at,
      });
    } catch {
      return;
    } // a parallel delivery stored it first

    // A new chat (or the first after a quiet day) counts as the person getting in touch: it lands on their lead.
    let leadId: string | null = convo.leadId ?? null;
    const freshTouch =
      !leadId || !windowOpen(convo.lastInboundAt, m.at.getTime());
    if (freshTouch) {
      const r = await this.capture.capture({
        name: m.name || `+${m.from}`,
        phone: `+${m.from}`,
        source: 'whatsapp',
        sourceDetail: 'WhatsApp message',
        note: m.text,
      });
      leadId = r.leadId;
      if (r.created)
        void this.capture.notifyManagers(
          `New WhatsApp lead: ${m.name || `+${m.from}`}`,
          m.text.slice(0, 140),
          leadId,
        );
    } else if (leadId) {
      await this.sales.log(leadId, 'whatsapp', m.text, null, {
        direction: 'in',
      });
    }
    await this.conversations.updateOne({ _id: convo._id }, {
      $set: {
        leadId,
        lastInboundAt: m.at,
        lastMessageAt: m.at,
        lastMessageText: m.text.slice(0, 200),
        ...(m.name ? { profileName: m.name } : {}),
      },
      $inc: { unread: 1 },
    } as any);
    if (leadId)
      await this.leads.updateOne(
        { _id: leadId },
        { $set: { lastActivityAt: new Date() } },
      );
    void this.notifyOwner(leadId, m);
    void this.refreshDraft(convoId, m.waMessageId);
  }

  // ── Inbox (sales users) ─────────────────────────────────────────────────────

  async listConversations(
    actor: SalesActor,
    q: { leadId?: string; unread?: boolean } = {},
  ) {
    const filter: Record<string, unknown> = {};
    if (q.leadId && isId(q.leadId)) filter.leadId = q.leadId;
    if (q.unread) filter.unread = { $gt: 0 };
    if (!actor.canSeeAll) {
      const mine: any[] = await this.leads
        .find({ ownerAdminId: actor.adminId, isDelete: false })
        .select('_id')
        .lean();
      filter.leadId =
        q.leadId && mine.some((l) => String(l._id) === q.leadId)
          ? q.leadId
          : { $in: mine.map((l) => String(l._id)) };
    }
    const rows: any[] = await this.conversations
      .find(filter)
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .lean();
    const leadRows: any[] = await this.leads
      .find({ _id: { $in: rows.map((r) => r.leadId).filter(isId) } })
      .select('name businessName stage ownerAdminId')
      .lean();
    const leadOf = new Map(leadRows.map((l) => [String(l._id), l]));
    return {
      success: true,
      data: rows.map((c) => {
        const lead = c.leadId ? leadOf.get(c.leadId) : null;
        return {
          _id: String(c._id),
          waId: c.waId,
          name: lead?.name ?? c.profileName ?? `+${c.waId}`,
          businessName: lead?.businessName ?? null,
          leadId: c.leadId ?? null,
          stage: lead?.stage ?? null,
          unread: c.unread ?? 0,
          lastMessageAt: c.lastMessageAt,
          lastMessageText: c.lastMessageText,
          windowOpen: windowOpen(c.lastInboundAt),
          hasDraft: !!c.aiDraft,
        };
      }),
    };
  }

  async getConversation(actor: SalesActor, id: string) {
    const rules = await this.sales.rules(actor);
    const c = await this.mustFind(actor, id);
    const msgs: any[] = await this.messages
      .find({ conversationId: id })
      .sort({ at: -1 })
      .limit(200)
      .lean();
    if (c.unread)
      await this.conversations.updateOne({ _id: id }, { $set: { unread: 0 } });
    const lead: any = c.leadId
      ? await this.leads
          .findById(c.leadId)
          .select('name businessName stage ownerAdminId email city')
          .lean()
      : null;
    const s = await this.load();
    return {
      success: true,
      data: {
        _id: String(c._id),
        waId: c.waId,
        profileName: c.profileName ?? null,
        lead: lead
          ? {
              _id: String(lead._id),
              name: lead.name,
              businessName: lead.businessName ?? null,
              stage: lead.stage,
              city: lead.city ?? null,
            }
          : null,
        windowOpen: windowOpen(c.lastInboundAt),
        windowClosesAt: c.lastInboundAt
          ? new Date(new Date(c.lastInboundAt).getTime() + 24 * 3_600_000)
          : null,
        aiDraft: c.aiDraft ?? null,
        // The first one stays as `template` for older screens.
        template: templatesOf(s)[0] ? { name: templatesOf(s)[0].name, lang: templatesOf(s)[0].lang } : null,
        // Only the templates this person may send; reps allowed templates only cannot write their own text.
        templates: rules.whatsapp === 'off' ? [] : templatesOf(s).filter((t) => SalesAccessService.allows(rules.waTemplateKeys, t.key))
          .map((t) => ({ key: t.key, label: t.label, name: t.name, lang: t.lang, body: t.body, reason: t.reason })),
        canWriteText: rules.whatsapp === 'full',
        messages: msgs
          .reverse()
          .map((x) => ({
            _id: String(x._id),
            direction: x.direction,
            type: x.type,
            text: x.text,
            status: x.status,
            error: x.error ?? null,
            at: x.at,
            fromAiDraft: !!x.fromAiDraft,
          })),
      },
    };
  }

  /** A person sends a reply (their own words or the AI's draft, edited or not). Free text only inside the 24-hour window. */
  async send(actor: SalesActor, id: string, text: string, fromAiDraft = false) {
    const body = text?.trim();
    if (!body) throw new BadRequestException('Write a message.');
    if (body.length > 4000)
      throw new BadRequestException(
        'WhatsApp messages can be up to 4,000 characters.',
      );
    const c = await this.mustFind(actor, id);
    SalesAccessService.require(await this.sales.rules(actor), 'whatsapp', 'text');
    if (!windowOpen(c.lastInboundAt))
      throw new BadRequestException(
        'It has been more than 24 hours since they last wrote, so WhatsApp only allows your approved template. Send the template to restart the chat.',
      );
    const { token, phoneNumberId } = await this.credentials();
    const r = await this.graph('POST', `/${phoneNumberId}/messages`, token, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: c.waId,
      type: 'text',
      text: { preview_url: false, body },
    });
    await this.record(actor, c, {
      type: 'text',
      text: body,
      fromAiDraft,
      result: r,
    });
    return this.getConversation(actor, id);
  }

  /** Restart a chat outside the 24-hour window with the approved template. */
  /**
   * Replaces the list of templates reps can pick from. Each one is looked up in Meta (the number's WhatsApp
   * Business Account): it must exist in that language, be approved, and need nothing but {{1}} (the first name),
   * or Meta would refuse it at send time. Its approved body is kept for the picker's preview.
   */
  async saveTemplates(input: { label?: string; name: string; lang: string; reason?: string }[]) {
    const s = await this.load();
    if (!Array.isArray(input) || input.length > MAX_WA_TEMPLATES)
      throw new BadRequestException(`Up to ${MAX_WA_TEMPLATES} templates.`);
    const rows = input.map((t) => ({ label: String(t?.label ?? '').trim().slice(0, 60), name: String(t?.name ?? '').trim(), lang: String(t?.lang ?? '').trim(), reason: asReason(t?.reason) }));
    const seen = new Set<string>();
    for (const r of rows) {
      if (!WA_TEMPLATE_NAME_RE.test(r.name))
        throw new BadRequestException(`"${r.name}" is not a template name: use the exact name from WhatsApp Manager (lowercase letters, numbers and _).`);
      if (!WA_TEMPLATE_LANG_RE.test(r.lang))
        throw new BadRequestException(`"${r.lang}" is not a language code: use the code Meta shows, e.g. en, en_US, ur.`);
      const key = waTemplateKey(r.name, r.lang);
      if (seen.has(key)) throw new BadRequestException(`${r.name} (${r.lang}) is listed twice.`);
      seen.add(key);
    }
    let saved: WaTemplate[] = [];
    if (rows.length) {
      if (!s.waWabaId || !s.waAccessTokenEnc)
        throw new BadRequestException('Connect Solvexo’s WhatsApp number first.');
      const { token } = await this.credentials();
      const byName = new Map<string, any[]>();
      for (const name of new Set(rows.map((r) => r.name))) {
        const r = await this.graph('GET', `/${s.waWabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status,components&limit=100`, token);
        if (!r.ok) throw new BadRequestException(`Meta did not list the templates: ${r.error}.`);
        byName.set(name, (Array.isArray(r.data?.data) ? r.data.data : []).filter((t: any) => t?.name === name));
      }
      saved = rows.map((r) => {
        const found = byName.get(r.name) ?? [];
        const t = found.find((x: any) => x?.language === r.lang);
        if (!t)
          throw new BadRequestException(found.length
            ? `Template ${r.name} has no ${r.lang} version in WhatsApp Manager (it has: ${found.map((x: any) => x.language).join(', ')}).`
            : `There is no template named ${r.name} in this WhatsApp account.`);
        if (String(t.status).toUpperCase() !== 'APPROVED')
          throw new BadRequestException(`Template ${r.name} (${r.lang}) is ${String(t.status ?? 'not approved').toLowerCase()}; only approved templates can be sent.`);
        const c = checkMetaTemplate(t.components);
        if (!c.ok) throw new BadRequestException(`Template ${r.name} (${r.lang}) can't be sent from Solvexo: ${c.problem}.`);
        return { key: waTemplateKey(r.name, r.lang), label: r.label || `${r.name} (${r.lang})`, name: r.name, lang: r.lang, usesName: c.usesName, body: c.body || null, reason: r.reason };
      });
    }
    const first = saved[0];
    await this.settings.updateOne(
      { key: 'default' },
      // The single-template fields follow the first entry, so anything still reading them stays right.
      { $set: { waTemplates: saved, waTemplateName: first?.name ?? null, waTemplateLang: first?.lang ?? 'en', waTemplateUsesName: !!first?.usesName } },
      { upsert: true },
    );
    return this.getConnection();
  }

  /** Sends one of the approved templates (the first when no key is given), with {{1}} = the person's first name. */
  async sendTemplate(actor: SalesActor, id: string, key?: string | null) {
    const c = await this.mustFind(actor, id);
    const s = await this.load();
    const list = templatesOf(s);
    if (!list.length)
      throw new BadRequestException(
        'Add an approved template in Sales Ops → WhatsApp → Templates first.',
      );
    const rules = await this.sales.rules(actor);
    SalesAccessService.require(rules, 'whatsapp', 'template');
    const mine = list.filter((x) => SalesAccessService.allows(rules.waTemplateKeys, x.key));
    const t = key ? list.find((x) => x.key === key) : mine[0];
    if (!t) throw new BadRequestException(mine.length ? 'That template is no longer in the list. Pick another one.' : 'You have no WhatsApp templates you are allowed to send. Ask a manager.');
    if (!SalesAccessService.allows(rules.waTemplateKeys, t.key)) throw new ForbiddenException('You are not allowed to send this template.');
    const { token, phoneNumberId } = await this.credentials();
    const lead: any = c.leadId
      ? await this.leads.findById(c.leadId).select('name').lean()
      : null;
    const firstName =
      String(lead?.name ?? c.profileName ?? '')
        .trim()
        .split(/\s+/)[0] || 'there';
    const r = await this.graph('POST', `/${phoneNumberId}/messages`, token, {
      messaging_product: 'whatsapp',
      to: c.waId,
      type: 'template',
      template: {
        name: t.name,
        language: { code: t.lang },
        ...(t.usesName
          ? {
              components: [
                {
                  type: 'body',
                  parameters: [{ type: 'text', text: firstName }],
                },
              ],
            }
          : {}),
      },
    });
    await this.record(actor, c, {
      type: 'template',
      // What the person actually received, when the approved body is known.
      text: t.body ? t.body.replace(/\{\{\s*1\s*\}\}/g, firstName) : `[Template: ${t.name}]`,
      fromAiDraft: false,
      result: r,
    });
    return this.getConversation(actor, id);
  }

  async redraft(actor: SalesActor, id: string) {
    await this.mustFind(actor, id);
    const ok = await this.refreshDraft(id, null);
    if (!ok)
      throw new BadRequestException(
        'The AI assistant could not write a draft. Check that it is switched on with WhatsApp drafts in Sales Ops → AI agent.',
      );
    return this.getConversation(actor, id);
  }

  async discardDraft(actor: SalesActor, id: string) {
    await this.mustFind(actor, id);
    await this.conversations.updateOne(
      { _id: id },
      { $set: { aiDraft: null } },
    );
    return this.getConversation(actor, id);
  }

  /** Start a WhatsApp chat from a lead's page: finds or opens the conversation for the lead's number. */
  async openForLead(actor: SalesActor, leadId: string) {
    SalesAccessService.require(await this.sales.rules(actor), 'whatsapp', 'template');
    const { data } = await this.sales.get(actor, leadId);
    const waId = toWaId(data.lead.phone);
    if (!waId)
      throw new BadRequestException(
        'This lead has no phone number WhatsApp can use.',
      );
    let c: any = await this.conversations.findOne({ waId }).lean();
    if (!c)
      c = await this.conversations.create({
        waId,
        profileName: null,
        leadId,
        unread: 0,
      });
    else if (!c.leadId)
      await this.conversations.updateOne({ _id: c._id }, { $set: { leadId } });
    return { success: true, data: { conversationId: String(c._id) } };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async record(
    actor: SalesActor,
    c: any,
    o: {
      type: string;
      text: string;
      fromAiDraft: boolean;
      result: { ok: boolean; data?: any; error?: string };
    },
  ) {
    const now = new Date();
    if (!o.result.ok) {
      await this.messages.create({
        conversationId: String(c._id),
        direction: 'out',
        type: o.type,
        text: o.text,
        status: 'failed',
        error: o.result.error ?? 'Meta refused the message',
        sentByAdminId: actor.adminId,
        fromAiDraft: o.fromAiDraft,
        at: now,
      });
      throw new BadRequestException(
        `WhatsApp did not send it: ${o.result.error ?? 'unknown error'}`,
      );
    }
    await this.messages.create({
      conversationId: String(c._id),
      direction: 'out',
      waMessageId: o.result.data?.messages?.[0]?.id ?? null,
      type: o.type,
      text: o.text,
      status: 'sent',
      sentByAdminId: actor.adminId,
      fromAiDraft: o.fromAiDraft,
      at: now,
    });
    await this.conversations.updateOne(
      { _id: c._id },
      {
        $set: {
          lastMessageAt: now,
          lastMessageText: o.text.slice(0, 200),
          unread: 0,
          ...(o.fromAiDraft || o.type === 'text' ? { aiDraft: null } : {}),
        },
      },
    );
    if (c.leadId)
      await this.sales
        .addActivity(
          actor,
          c.leadId,
          'whatsapp',
          o.text,
          o.fromAiDraft ? 'Sent (AI draft)' : 'Sent',
        )
        .catch(() => undefined);
  }

  private async refreshDraft(
    conversationId: string,
    forMessageId: string | null,
  ): Promise<boolean> {
    const msgs: any[] = await this.messages
      .find({ conversationId })
      .sort({ at: -1 })
      .limit(30)
      .lean();
    if (!msgs.length) return false;
    const turns = msgs
      .reverse()
      .map((x) => ({
        role: (x.direction === 'in' ? 'visitor' : 'agent') as
          | 'visitor'
          | 'agent',
        text: x.text,
      }));
    const c: any = await this.conversations
      .findById(conversationId)
      .select('leadId profileName')
      .lean();
    const lead: any = c?.leadId
      ? await this.leads
          .findById(c.leadId)
          .select('name businessName city businessType email')
          .lean()
      : null;
    const text = await this.agent.draftWhatsApp(turns, {
      name: lead?.name ?? c?.profileName ?? undefined,
      businessName: lead?.businessName ?? undefined,
      city: lead?.city ?? undefined,
      businessType: lead?.businessType ?? undefined,
      email: lead?.email ?? undefined,
    });
    if (!text) return false;
    // Only keep it if no newer message arrived meanwhile.
    const latest: any = await this.messages
      .findOne({ conversationId, direction: 'in' })
      .sort({ at: -1 })
      .select('waMessageId')
      .lean();
    if (forMessageId && latest?.waMessageId !== forMessageId) return false;
    await this.conversations.updateOne(
      { _id: conversationId },
      { $set: { aiDraft: { text, createdAt: new Date(), forMessageId } } },
    );
    return true;
  }

  private async notifyOwner(leadId: string | null, m: InboundMessage) {
    if (!leadId) return;
    const lead: any = await this.leads
      .findById(leadId)
      .select('ownerAdminId name')
      .lean();
    if (!lead?.ownerAdminId) return; // unassigned: managers already heard about a new lead
    await this.notifications
      .notify({
        recipientId: lead.ownerAdminId,
        recipientRole: 'admin',
        type: NOTIFICATION_TYPES.ADMIN_SALES_LEAD,
        title: `WhatsApp from ${lead.name}`,
        body: m.text.slice(0, 140),
        data: { link: `/admin/sales?tab=whatsapp&lead=${leadId}` },
      })
      .catch(() => undefined);
  }

  private async mustFind(actor: SalesActor, id: string): Promise<any> {
    if (!isId(id)) throw new NotFoundException('Conversation not found.');
    const c: any = await this.conversations.findById(id).lean();
    if (!c) throw new NotFoundException('Conversation not found.');
    if (!actor.canSeeAll) {
      const lead: any = c.leadId
        ? await this.leads.findById(c.leadId).select('ownerAdminId').lean()
        : null;
      if (lead?.ownerAdminId !== actor.adminId)
        throw new NotFoundException('Conversation not found.');
    }
    return c;
  }

  private async credentials() {
    const s = await this.load();
    if (!s.waPhoneNumberId || !s.waAccessTokenEnc)
      throw new ForbiddenException(
        'Solvexo’s WhatsApp number is not connected yet (Sales Ops → WhatsApp).',
      );
    return {
      phoneNumberId: s.waPhoneNumberId as string,
      token: decryptCredential(s.waAccessTokenEnc, 'INTEGRATIONS'),
    };
  }

  /**
   * The WhatsApp Business Account that owns the number, confirmed by `/{waba}/phone_numbers` listing it.
   * Candidates: an ID the admin typed (or the one saved before) first, then the accounts the token was granted
   * (debug_token's granular scopes). `detail` explains a typed ID that did not work, with Meta's own answer.
   */
  private async findWabaId(phoneNumberId: string, token: string, hint: string | null): Promise<{ wabaId: string | null; detail: string | null }> {
    const check = async (waba: string) => {
      const r = await this.graph('GET', `/${waba}/phone_numbers?fields=id,display_phone_number&limit=100`, token);
      const nums: any[] = r.ok && Array.isArray(r.data?.data) ? r.data.data : [];
      return { owns: nums.some((n) => String(n?.id) === phoneNumberId), error: r.ok ? null : r.error ?? 'refused', nums };
    };
    let detail: string | null = null;
    if (hint) {
      const c = await check(hint);
      if (c.owns) return { wabaId: hint, detail: null };
      detail = c.error
        ? `Meta refused to list the numbers of WhatsApp Business Account ${hint}: ${c.error}`
        : `WhatsApp Business Account ${hint} lists ${c.nums.length ? c.nums.map((n) => `${n.display_phone_number ?? '?'} (ID ${n.id})`).join(', ') : 'no numbers this token can see'}, not ID ${phoneNumberId}`;
    }
    // debug_token answers reliably when asked with the app's own token (APP_ID|APP_SECRET, the same app the
    // webhook uses); a system user's token may not be allowed to inspect itself.
    const appId = process.env.META_APP_ID?.trim();
    const appSecret = process.env.META_APP_SECRET?.trim();
    const dbg = await this.graph('GET', `/debug_token?input_token=${encodeURIComponent(token)}`, appId && appSecret ? `${appId}|${appSecret}` : token);
    const scopes: any[] = Array.isArray(dbg.data?.data?.granular_scopes) ? dbg.data.data.granular_scopes : [];
    const ids = [...new Set(scopes
      .filter((x) => x?.scope === 'whatsapp_business_management' || x?.scope === 'whatsapp_business_messaging')
      .flatMap((x) => (Array.isArray(x?.target_ids) ? x.target_ids.map(String) : [])))]
      .filter((id) => /^\d{5,30}$/.test(id) && id !== hint)
      .slice(0, 20);
    for (const id of ids) if ((await check(id)).owns) return { wabaId: id, detail: null };
    // Say what the token can reach, so the admin can tell a wrong ID from a missing permission.
    const reach = !dbg.ok
      ? `Meta did not say which WhatsApp Business Accounts this token can reach (${dbg.error ?? 'refused'})`
      : ids.length
        ? `This token can reach WhatsApp Business Account${ids.length > 1 ? 's' : ''} ${ids.join(', ')}, but none lists number ${phoneNumberId}`
        : 'This token has no WhatsApp Business Account assigned: give the system user full control of the WhatsApp account, then generate a new token';
    return { wabaId: null, detail: detail ? `${detail}. ${reach}` : reach };
  }

  private async graph(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
      const res = await this.fetchImpl(`${GRAPH}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok)
        return {
          ok: false,
          error:
            data?.error?.error_user_msg ||
            data?.error?.message ||
            `HTTP ${res.status}`,
        };
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'network error' };
    }
  }

  private async load(): Promise<any> {
    return (await this.settings.findOne({ key: 'default' }).lean()) ?? {};
  }
}
