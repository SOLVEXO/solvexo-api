/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MESSAGING_LEVELS, type MessagingLevel, SalesRepAccess, SalesRepAccessDocument } from './schemas/sales-rep-access.schema';
import { type SalesActor } from './sales-ops.util';

export interface MessagingRules {
  whatsapp: MessagingLevel;
  email: MessagingLevel;
  /** null = every template. */
  waTemplateKeys: string[] | null;
  emailTemplateIds: string[] | null;
}

/** Managers (and anyone who sees every lead) have no limits. */
export const FULL_ACCESS: MessagingRules = { whatsapp: 'full', email: 'full', waTemplateKeys: null, emailTemplateIds: null };

const LABEL: Record<'whatsapp' | 'email', string> = { whatsapp: 'WhatsApp', email: 'email' };
type Row = Partial<MessagingRules> & { adminId: string };
const toRules = (r: Row): MessagingRules => ({
  whatsapp: r.whatsapp ?? 'full', email: r.email ?? 'full', waTemplateKeys: r.waTemplateKeys ?? null, emailTemplateIds: r.emailTemplateIds ?? null,
});

/** Per-rep messaging rules: what each sales rep may send to their clients, on WhatsApp and by email. */
@Injectable()
export class SalesAccessService {
  constructor(@InjectModel(SalesRepAccess.name) private readonly access: Model<SalesRepAccessDocument>) {}

  async rulesFor(actor: SalesActor): Promise<MessagingRules> {
    if (actor.canSeeAll) return FULL_ACCESS;
    const row = await this.access.findOne({ adminId: actor.adminId }).lean<Row>();
    return row ? toRules(row) : FULL_ACCESS;
  }

  /** Throws unless the actor may send on this channel at all (`templates` or `full`), or their own text (`full`). */
  static require(rules: MessagingRules, channel: 'whatsapp' | 'email', need: 'template' | 'text') {
    const level = rules[channel];
    if (level === 'off') throw new ForbiddenException(`You are not allowed to send ${LABEL[channel]} messages to clients. Ask a manager.`);
    if (need === 'text' && level !== 'full')
      throw new ForbiddenException(`You can only send approved ${LABEL[channel]} templates to clients, not your own text.`);
  }

  static allows(list: string[] | null, id: string) {
    return list === null || list.includes(id);
  }

  /** Every rep's saved rules (reps without a row use the defaults). */
  async list(): Promise<Record<string, MessagingRules>> {
    const rows = await this.access.find({}).lean<Row[]>();
    return Object.fromEntries(rows.map((r) => [r.adminId, toRules(r)]));
  }

  async save(adminId: string, input: Partial<MessagingRules>) {
    if (!/^[a-f0-9]{24}$/i.test(adminId)) throw new BadRequestException('Unknown team member.');
    const set: Record<string, unknown> = {};
    for (const k of ['whatsapp', 'email'] as const) {
      if (input[k] === undefined) continue;
      if (!(MESSAGING_LEVELS as readonly string[]).includes(input[k] as string)) throw new BadRequestException(`Choose off, templates or full for ${LABEL[k]}.`);
      set[k] = input[k];
    }
    for (const k of ['waTemplateKeys', 'emailTemplateIds'] as const) {
      if (input[k] === undefined) continue;
      const v = input[k];
      set[k] = v === null ? null : [...new Set((Array.isArray(v) ? v : []).map(String).filter(Boolean))].slice(0, 100);
    }
    await this.access.updateOne({ adminId }, { $set: set, $setOnInsert: { adminId } }, { upsert: true });
    return { success: true, data: await this.list() };
  }
}
