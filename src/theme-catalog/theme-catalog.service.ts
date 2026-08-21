/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import {
  validateSectionSettings, validateBlockSettings, SECTION_ALLOWED_BLOCK_TYPES,
  validateBlocks, HEADER_ALLOWED_BLOCK_TYPES, FOOTER_ALLOWED_BLOCK_TYPES,
} from '../common/store-content/section-settings.validator';
import type { SectionType } from '../common/schemas/section.schema';
import { CreateThemeDefinitionDto } from './dto/create-theme-definition.dto';
import { UpdateThemeDefinitionDto } from './dto/update-theme-definition.dto';
import { ListThemeQueryDto } from './dto/list-theme-query.dto';

const MAX_HOME_SECTIONS = 40; // same cap StorePage already enforces
const MAX_HEADER_LINKS = 10;
const MAX_FOOTER_BLOCKS = 20;

function validateHomePageSections(sections: Record<string, any>[] | undefined): void {
  if (sections === undefined) return;
  if (sections.length > MAX_HOME_SECTIONS) {
    throw new BadRequestException(`A theme's home page cannot have more than ${MAX_HOME_SECTIONS} sections`);
  }
  for (const section of sections) {
    const type = section.type as SectionType;
    validateSectionSettings(type, section.settings ?? {});
    const allowed = SECTION_ALLOWED_BLOCK_TYPES[type] ?? [];
    for (const block of section.blocks ?? []) {
      if (allowed.length > 0 && !allowed.includes(block.type)) {
        throw new BadRequestException(`Block type "${block.type}" is not allowed in a "${type}" section`);
      }
      validateBlockSettings(block.type, block.settings ?? {});
    }
  }
}

/** Same rule a seller's own Header/Footer tab edits go through (`StoreThemeService.updateHeader`/`updateFooter`) — a catalog theme's header/footer blocks must be equally valid. */
function validateHeaderFooter(header: Record<string, any> | undefined, footer: Record<string, any> | undefined): void {
  if (header?.blocks) validateBlocks(header.blocks, HEADER_ALLOWED_BLOCK_TYPES, MAX_HEADER_LINKS);
  if (footer?.blocks) validateBlocks(footer.blocks, FOOTER_ALLOWED_BLOCK_TYPES, MAX_FOOTER_BLOCKS);
}

/**
 * Admin-managed global theme catalog. Sellers only ever read from this
 * service (list/detail/apply) — every mutation is admin-only, matching the
 * `admin-marketplace`/`admin-config` guard convention at the controller
 * layer. See `StoreThemeService.applyThemeDefinition` for how a theme's
 * fields get copied into a seller's own store (the only place cross-tenant
 * data actually moves).
 */
@Injectable()
export class ThemeCatalogService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get themeDefinitionModel() {
    return this.databaseService.repositories.themeDefinitionModel;
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  async create(dto: CreateThemeDefinitionDto) {
    validateHomePageSections(dto.homePageSections);
    validateHeaderFooter(dto.header, dto.footer);
    const existing = await this.themeDefinitionModel.findOne({ slug: dto.slug });
    if (existing) throw new ConflictException(`A theme with slug "${dto.slug}" already exists`);
    const created = await this.themeDefinitionModel.create(dto);
    return { success: true, message: 'Theme created', data: created };
  }

  async adminList(query: { category?: string; status?: string; search?: string }) {
    const filter: Record<string, any> = {};
    if (query.category) filter.category = query.category;
    if (query.status) filter.status = query.status;
    if (query.search) filter.name = { $regex: query.search, $options: 'i' };
    const themes = await this.themeDefinitionModel.find(filter).sort({ category: 1, name: 1 }).lean();
    return { success: true, data: themes };
  }

  async adminGetById(id: string) {
    const theme = await this.themeDefinitionModel.findById(id);
    if (!theme) throw new NotFoundException('Theme not found');
    return { success: true, data: theme };
  }

  async update(id: string, dto: UpdateThemeDefinitionDto) {
    validateHomePageSections(dto.homePageSections);
    validateHeaderFooter(dto.header, dto.footer);
    const theme = await this.themeDefinitionModel.findById(id);
    if (!theme) throw new NotFoundException('Theme not found');
    if (dto.slug && dto.slug !== theme.slug) {
      const existing = await this.themeDefinitionModel.findOne({ slug: dto.slug, _id: { $ne: id } });
      if (existing) throw new ConflictException(`A theme with slug "${dto.slug}" already exists`);
    }
    Object.assign(theme, dto, { version: theme.version + 1 });
    await theme.save();
    return { success: true, message: 'Theme updated', data: theme };
  }

  async setStatus(id: string, status: 'draft' | 'published' | 'archived') {
    const theme = await this.themeDefinitionModel.findByIdAndUpdate(id, { $set: { status } }, { new: true });
    if (!theme) throw new NotFoundException('Theme not found');
    return { success: true, message: `Theme ${status}`, data: theme };
  }

  async setFeatured(id: string, featured: boolean) {
    const theme = await this.themeDefinitionModel.findByIdAndUpdate(id, { $set: { featured } }, { new: true });
    if (!theme) throw new NotFoundException('Theme not found');
    return { success: true, message: 'Theme updated', data: theme };
  }

  // ── Seller / public browsing ────────────────────────────────────────────

  /** Only ever returns published themes — draft/archived catalog entries are admin-preview-only via `adminGetById`. */
  async publicList(query: ListThemeQueryDto) {
    const filter: Record<string, any> = { status: 'published' };
    if (query.category) filter.category = query.category;
    if (query.tier) filter.tier = query.tier;
    if (query.featured !== undefined) filter.featured = query.featured;
    if (query.search) {
      filter.$or = [
        { name: { $regex: query.search, $options: 'i' } },
        { description: { $regex: query.search, $options: 'i' } },
        { tags: { $regex: query.search, $options: 'i' } },
      ];
    }
    const themes = await this.themeDefinitionModel
      .find(filter)
      .select('-homePageSections') // list view doesn't need the full section payload
      .sort({ featured: -1, category: 1, name: 1 })
      .lean();
    return { success: true, data: themes };
  }

  async publicGetBySlug(slug: string) {
    const theme = await this.themeDefinitionModel.findOneAndUpdate(
      { slug, status: 'published' },
      { $inc: { viewCount: 1 } },
      { new: true },
    );
    if (!theme) throw new NotFoundException('Theme not found');
    return { success: true, data: theme };
  }

  /** Internal lookup used by `StoreThemeService.applyThemeDefinition` — not exposed as its own route. */
  async getPublishedForApply(themeDefinitionId: string) {
    const theme = await this.themeDefinitionModel.findOne({ _id: themeDefinitionId, status: 'published' });
    if (!theme) throw new NotFoundException('Theme not found or not available');
    return theme;
  }

  async incrementApplyCount(themeDefinitionId: string) {
    await this.themeDefinitionModel.updateOne({ _id: themeDefinitionId }, { $inc: { applyCount: 1 } });
  }
}
