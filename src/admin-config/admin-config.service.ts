/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { UpdateFeatureFlagsDto } from './dto/update-feature-flags.dto';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';
import { UpdateEmailConfigDto } from './dto/update-email-config.dto';

export type FeatureFlagKey =
  | 'aiStudio' | 'marketplace' | 'digitalUploads' | 'affiliateProgram'
  | 'giftCards' | 'posMode' | 'storeBuilder' | 'bulkProductImport';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

// Singleton settings document — always the same (only) row in the collection,
// fetched/created lazily via upsert so there's no separate "seed" step.
@Injectable()
export class AdminConfigService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get model() {
    return this.databaseService.repositories.platformConfigModel;
  }

  // FeatureFlagGuard and the maintenance-mode middleware both call this on
  // (almost) every request — a short in-memory cache avoids a DB round trip
  // per request while still picking up an admin's change within a few
  // seconds. Invalidated eagerly on every write below anyway.
  private cached: { config: any; expiresAt: number } | null = null;
  private readonly CACHE_TTL_MS = 5000;

  private async getRawConfig() {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.config;
    const config = await this.model.findOneAndUpdate({}, {}, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.cached = { config, expiresAt: Date.now() + this.CACHE_TTL_MS };
    return config;
  }

  private invalidateCache() {
    this.cached = null;
  }

  async getConfig() {
    const config = await this.getRawConfig();
    return { success: true, data: config };
  }

  /** Used by FeatureFlagGuard — true unless an admin has explicitly turned this flag off. */
  async isFeatureEnabled(flag: FeatureFlagKey): Promise<boolean> {
    const config = await this.getRawConfig();
    return config.featureFlags?.[flag] !== false;
  }

  /** Used by the maintenance-mode middleware in main.ts. */
  async isMaintenanceMode(): Promise<boolean> {
    const config = await this.getRawConfig();
    return config.maintenanceMode === true;
  }

  private async logChange(action: string, description: string, meta: AuditMeta) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'settings',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async updateFeatureFlags(dto: UpdateFeatureFlagsDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`featureFlags.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('feature_flags_updated', `Feature flags updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Feature flags updated', data: config };
  }

  async updateAiConfig(dto: UpdateAiConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    if (dto.monthlyCreditLimit !== undefined) set['aiConfig.monthlyCreditLimit'] = dto.monthlyCreditLimit;
    if (dto.aiModel !== undefined) set['aiConfig.aiModel'] = dto.aiModel;
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('ai_config_updated', `AI config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'AI config updated', data: config };
  }

  async updateEmailConfig(dto: UpdateEmailConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`emailConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('email_config_updated', `Email config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Email config updated', data: config };
  }

  async setMaintenanceMode(maintenanceMode: boolean, meta: AuditMeta) {
    const config = await this.model.findOneAndUpdate(
      {},
      { $set: { maintenanceMode } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    this.invalidateCache();
    await this.logChange('maintenance_mode_toggled', `Maintenance mode set to ${maintenanceMode}`, {
      ...meta,
    });
    return { success: true, message: 'Maintenance mode updated', data: config };
  }
}
