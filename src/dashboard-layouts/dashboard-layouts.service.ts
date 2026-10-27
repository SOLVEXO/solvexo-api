import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DashboardLayout, DashboardLayoutDocument } from './dashboard-layout.schema';
import { DashboardScope, StoredLayout, pruneLayout, validateLayout } from './dashboard-widgets.const';

@Injectable()
export class DashboardLayoutsService {
  constructor(
    @InjectModel(DashboardLayout.name) private readonly model: Model<DashboardLayoutDocument>,
    private readonly databaseService: DatabaseService,
  ) {}

  private key(scope: DashboardScope, ownerId: string, storeId: string) {
    return { scope, ownerId: String(ownerId), storeId: scope === 'store' ? String(storeId) : '' };
  }

  /** A seller must own the store; a staff caller was already pinned to its own store by PermissionsGuard, and acts for the owning seller. */
  async assertStoreAccess(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.databaseService.repositories.storeModel, storeId, sellerId);
  }

  /** `layout: null` = the person never saved one, the web then shows the built-in default. */
  async get(scope: DashboardScope, ownerId: string, storeId = '') {
    const doc = await this.model.findOne(this.key(scope, ownerId, storeId)).lean();
    if (!doc) return { success: true, data: { layout: null } };
    const layout: StoredLayout = pruneLayout(scope, {
      preset: doc.preset ?? null,
      columns: doc.columns === 2 ? 2 : 3,
      widgets: (doc.widgets ?? []).map((w) => ({ id: w.id, visible: !!w.visible, size: w.size as StoredLayout['widgets'][number]['size'], settings: w.settings ?? {} })),
    });
    return { success: true, data: { layout } };
  }

  async save(scope: DashboardScope, ownerId: string, storeId: string, body: unknown) {
    const layout = validateLayout(scope, body);
    await this.model.updateOne(this.key(scope, ownerId, storeId), { $set: layout }, { upsert: true });
    return { success: true, data: { layout } };
  }

  async reset(scope: DashboardScope, ownerId: string, storeId = '') {
    await this.model.deleteOne(this.key(scope, ownerId, storeId));
    return { success: true, data: { layout: null } };
  }
}
