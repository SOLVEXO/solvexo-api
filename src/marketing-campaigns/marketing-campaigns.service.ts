/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { pickFields } from '../common/pick-fields.util';
import { CreateMarketingCampaignDto, UpdateMarketingCampaignDto } from './dto/marketing-campaign.dto';

/** "Summer Sale 2026!" becomes "summer-sale-2026" — the UTM campaign value made from a campaign name. */
export function slugifyCampaignName(name: string): string {
  return String(name ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

const UPDATABLE = ['name', 'channel', 'notes', 'status'] as const;

@Injectable()
export class MarketingCampaignsService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get r() { return this.databaseService.repositories; }

  private async owned(sellerId: string, storeId: string) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid store');
    return verifyStoreOwnershipOrForbidden(this.r.storeModel as any, storeId, sellerId);
  }

  async list(sellerId: string, storeId: string) {
    await this.owned(sellerId, storeId);
    const campaigns = await this.r.marketingCampaignModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).limit(500).lean();
    return { success: true, data: campaigns };
  }

  async create(sellerId: string, storeId: string, dto: CreateMarketingCampaignDto) {
    await this.owned(sellerId, storeId);
    const utmCampaign = (dto.utmCampaign?.trim() || slugifyCampaignName(dto.name)).toLowerCase();
    if (!utmCampaign) throw new BadRequestException('Give the campaign a name or a campaign tag');
    if (await this.r.marketingCampaignModel.exists({ storeId, utmCampaign, isDelete: false })) {
      throw new ConflictException(`A campaign with the tag "${utmCampaign}" already exists`);
    }
    try {
      const created = await this.r.marketingCampaignModel.create({
        storeId,
        name: dto.name.trim(),
        channel: dto.channel ?? 'other',
        utmCampaign,
        utmSource: dto.utmSource?.trim() || null,
        utmMedium: dto.utmMedium?.trim() || null,
        notes: dto.notes ?? '',
      });
      return { success: true, message: 'Campaign created', data: created };
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException(`A campaign with the tag "${utmCampaign}" already exists`);
      throw e;
    }
  }

  async update(sellerId: string, storeId: string, id: string, dto: UpdateMarketingCampaignDto) {
    await this.owned(sellerId, storeId);
    if (!isValidObjectId(id)) throw new NotFoundException('Campaign not found');
    const changes = pickFields(dto, UPDATABLE);
    if (typeof changes.name === 'string') changes.name = changes.name.trim();
    const updated = await this.r.marketingCampaignModel.findOneAndUpdate({ _id: id, storeId, isDelete: false }, { $set: changes }, { new: true });
    if (!updated) throw new NotFoundException('Campaign not found');
    return { success: true, message: 'Campaign updated', data: updated };
  }

  async remove(sellerId: string, storeId: string, id: string) {
    await this.owned(sellerId, storeId);
    if (!isValidObjectId(id)) throw new NotFoundException('Campaign not found');
    const res = await this.r.marketingCampaignModel.updateOne({ _id: id, storeId, isDelete: false }, { $set: { isDelete: true } });
    if (!res.matchedCount) throw new NotFoundException('Campaign not found');
    return { success: true, message: 'Campaign deleted' };
  }
}
