import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { StoreChatSettings, StoreChatSettingsDocument } from './store-chat-settings.schema';
import { UpdateStoreChatSettingsDto } from './dto/update-store-chat-settings.dto';

type View = { avatarUrl: string | null; name: string | null; statusLine: string | null; greeting: string | null };
const EMPTY: View = { avatarUrl: null, name: null, statusLine: null, greeting: null };

@Injectable()
export class StoreChatSettingsService {
  constructor(
    @InjectModel(StoreChatSettings.name) private readonly model: Model<StoreChatSettingsDocument>,
    private readonly databaseService: DatabaseService,
  ) {}

  private async read(storeId: string): Promise<View> {
    const doc = await this.model.findOne({ storeId: String(storeId) }).lean();
    if (!doc) return { ...EMPTY };
    return { avatarUrl: doc.avatarUrl ?? null, name: doc.name ?? null, statusLine: doc.statusLine ?? null, greeting: doc.greeting ?? null };
  }

  /** Public (storefront chat header): only the four display fields. */
  getPublic(storeId: string) {
    return this.read(storeId).then(data => ({ success: true, data }));
  }

  async getForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.databaseService.repositories.storeModel, storeId, sellerId);
    return { success: true, data: await this.read(storeId) };
  }

  async update(storeId: string, sellerId: string, dto: UpdateStoreChatSettingsDto) {
    await verifyStoreOwnershipOrForbidden(this.databaseService.repositories.storeModel, storeId, sellerId);
    const set: Partial<View> = {};
    const text = (v: string | undefined) => { const t = (v ?? '').trim(); return t === '' ? null : t; };
    if (dto.name !== undefined) set.name = text(dto.name);
    if (dto.statusLine !== undefined) set.statusLine = text(dto.statusLine);
    if (dto.greeting !== undefined) set.greeting = text(dto.greeting);
    if (dto.avatarUrl !== undefined) {
      const url = text(dto.avatarUrl);
      if (url && !/^https:\/\/\S+$/i.test(url)) throw new BadRequestException('The photo must be an https link');
      set.avatarUrl = url;
    }
    await this.model.updateOne({ storeId: String(storeId) }, { $set: set, $setOnInsert: { storeId: String(storeId) } }, { upsert: true });
    return { success: true, message: 'Chat settings saved', data: await this.read(storeId) };
  }
}
