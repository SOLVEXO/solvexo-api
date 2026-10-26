import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { resolveStoreTimeZone } from '../common/store-timezone.util';
import { ChatHoursDay, QuickReply, StoreChatSettings, StoreChatSettingsDocument } from './store-chat-settings.schema';
import { UpdateStoreChatSettingsDto } from './dto/update-store-chat-settings.dto';

type PublicView = { avatarUrl: string | null; name: string | null; statusLine: string | null; greeting: string | null };
type SellerView = PublicView & { autoReplyEnabled: boolean; autoReplyText: string | null; autoReplyOnlyOutsideHours: boolean; hours: ChatHoursDay[]; quickReplies: QuickReply[] };

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const defaultHours = (): ChatHoursDay[] => DAYS.map(day => ({ day, open: day >= 1 && day <= 5, from: '09:00', to: '18:00' }));
const EMPTY: SellerView = {
  avatarUrl: null, name: null, statusLine: null, greeting: null,
  autoReplyEnabled: false, autoReplyText: null, autoReplyOnlyOutsideHours: false, hours: defaultHours(), quickReplies: [],
};

/** Whether the store is open at `now` according to `hours` (store time zone). A day with no entry counts as closed. */
export function isOpenAt(hours: ChatHoursDay[], timeZone: string, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const entry = hours.find(h => h.day === day);
  if (!entry || !entry.open) return false;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const from = toMin(entry.from);
  const to = toMin(entry.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to; // an overnight shift ends after midnight
}

@Injectable()
export class StoreChatSettingsService {
  constructor(
    @InjectModel(StoreChatSettings.name) private readonly model: Model<StoreChatSettingsDocument>,
    private readonly databaseService: DatabaseService,
  ) {}

  private async read(storeId: string): Promise<SellerView> {
    const doc = await this.model.findOne({ storeId: String(storeId) }).lean();
    if (!doc) return { ...EMPTY, hours: defaultHours() };
    return {
      avatarUrl: doc.avatarUrl ?? null, name: doc.name ?? null, statusLine: doc.statusLine ?? null, greeting: doc.greeting ?? null,
      autoReplyEnabled: !!doc.autoReplyEnabled, autoReplyText: doc.autoReplyText ?? null, autoReplyOnlyOutsideHours: !!doc.autoReplyOnlyOutsideHours,
      hours: doc.hours?.length ? doc.hours : defaultHours(), quickReplies: doc.quickReplies ?? [],
    };
  }

  /** Public (storefront chat header): only the four display fields, never the auto-reply or canned replies. */
  async getPublic(storeId: string) {
    const v = await this.read(storeId);
    const data: PublicView = { avatarUrl: v.avatarUrl, name: v.name, statusLine: v.statusLine, greeting: v.greeting };
    return { success: true, data };
  }

  async getForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.databaseService.repositories.storeModel, storeId, sellerId);
    return { success: true, data: await this.read(storeId) };
  }

  async update(storeId: string, sellerId: string, dto: UpdateStoreChatSettingsDto) {
    await verifyStoreOwnershipOrForbidden(this.databaseService.repositories.storeModel, storeId, sellerId);
    const set: Record<string, unknown> = {};
    const text = (v: string | undefined) => { const t = (v ?? '').trim(); return t === '' ? null : t; };
    if (dto.name !== undefined) set.name = text(dto.name);
    if (dto.statusLine !== undefined) set.statusLine = text(dto.statusLine);
    if (dto.greeting !== undefined) set.greeting = text(dto.greeting);
    if (dto.avatarUrl !== undefined) {
      const url = text(dto.avatarUrl);
      if (url && !/^https:\/\/\S+$/i.test(url)) throw new BadRequestException('The photo must be an https link');
      set.avatarUrl = url;
    }
    if (dto.autoReplyEnabled !== undefined) set.autoReplyEnabled = dto.autoReplyEnabled;
    if (dto.autoReplyOnlyOutsideHours !== undefined) set.autoReplyOnlyOutsideHours = dto.autoReplyOnlyOutsideHours;
    if (dto.autoReplyText !== undefined) set.autoReplyText = text(dto.autoReplyText);
    if (dto.hours !== undefined) {
      const days = new Set(dto.hours.map(h => h.day));
      if (days.size !== dto.hours.length) throw new BadRequestException('Each weekday can only be listed once');
      set.hours = dto.hours.map(h => ({ day: h.day, open: h.open, from: h.from, to: h.to }));
    }
    if (dto.quickReplies !== undefined) {
      set.quickReplies = dto.quickReplies
        .map(q => ({ title: q.title.trim(), text: q.text.trim() }))
        .filter(q => q.title && q.text);
    }
    const next = { ...(await this.read(storeId)), ...set } as SellerView;
    if (next.autoReplyEnabled && !next.autoReplyText) throw new BadRequestException('Write the auto-reply message before switching it on');
    await this.model.updateOne({ storeId: String(storeId) }, { $set: set, $setOnInsert: { storeId: String(storeId) } }, { upsert: true });
    return { success: true, message: 'Chat settings saved', data: await this.read(storeId) };
  }

  /** The auto-reply text to send for a buyer's message right now, or null (switched off, or the store is open and the
   *  seller only wants it outside hours). */
  async autoReplyFor(storeId: string, now = new Date()): Promise<string | null> {
    const v = await this.read(storeId);
    if (!v.autoReplyEnabled || !v.autoReplyText) return null;
    if (!v.autoReplyOnlyOutsideHours) return v.autoReplyText;
    const store = await this.databaseService.repositories.storeModel.findById(storeId).select('timezone country').lean();
    return isOpenAt(v.hours, resolveStoreTimeZone(store as any), now) ? null : v.autoReplyText;
  }
}
