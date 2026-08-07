/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlockSettings } from '../common/store-content/section-settings.validator';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';

const HEADER_ALLOWED_BLOCK_TYPES = ['nav_link'];
const FOOTER_ALLOWED_BLOCK_TYPES = ['footer_column', 'social_link', 'copyright_text'];
const MAX_HEADER_LINKS = 10;
const MAX_FOOTER_BLOCKS = 20;

function validateBlocks(blocks: { type: string; settings: Record<string, any> }[], allowed: string[], max: number) {
  if (blocks.length > max) throw new BadRequestException(`Cannot have more than ${max} items`);
  for (const block of blocks) {
    if (!allowed.includes(block.type)) throw new BadRequestException(`Block type "${block.type}" is not allowed here`);
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

@Injectable()
export class StoreThemeService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get storeThemeModel() {
    return this.databaseService.repositories.storeThemeModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  /** Idempotent — called once from `StoreService.createStore()` right after a store is created, and safe to call again (upsert) for the one-off backfill of pre-existing stores. Never called from an unauthenticated read path (see plan: eager creation avoids a public-GET-does-a-write race). */
  async ensureDefaultTheme(storeId: string) {
    return this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $setOnInsert: { storeId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  async getForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const theme = await this.ensureDefaultTheme(storeId);
    return { success: true, data: theme };
  }

  async getPublic(storeId: string) {
    const theme = await this.storeThemeModel.findOne({ storeId }).lean();
    return { success: true, data: theme };
  }

  async updateTheme(storeId: string, sellerId: string, dto: UpdateThemeDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`theme.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { success: true, message: 'Theme updated', data: updated };
  }

  async updateHeader(storeId: string, sellerId: string, dto: UpdateHeaderDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    if (dto.blocks) validateBlocks(dto.blocks, HEADER_ALLOWED_BLOCK_TYPES, MAX_HEADER_LINKS);

    const set: Record<string, unknown> = {};
    if (dto.logoSource !== undefined) set['header.logoSource'] = dto.logoSource;
    if (dto.customLogoUrl !== undefined) set['header.customLogoUrl'] = dto.customLogoUrl;
    if (dto.blocks !== undefined) set['header.blocks'] = dto.blocks;

    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { success: true, message: 'Header updated', data: updated };
  }

  async updateFooter(storeId: string, sellerId: string, dto: UpdateFooterDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    validateBlocks(dto.blocks, FOOTER_ALLOWED_BLOCK_TYPES, MAX_FOOTER_BLOCKS);

    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $set: { 'footer.blocks': dto.blocks } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { success: true, message: 'Footer updated', data: updated };
  }

  async updateIdentityBanner(storeId: string, sellerId: string, dto: UpdateIdentityBannerDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`identityBanner.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { success: true, message: 'Store info updated', data: updated };
  }
}
