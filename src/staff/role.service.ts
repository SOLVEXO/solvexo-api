/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

/** Seeded, non-deletable starter roles per store — mirrors Shopify's own
 *  out-of-the-box role concept (a seller isn't forced to build every role
 *  from scratch). Created lazily the first time a store's roles are
 *  listed, not via a migration — a store that never opens Staff/Roles
 *  never gets these rows. */
const PRESET_ROLES: { name: string; description: string; permissions: string[] }[] = [
  {
    name: 'Store Manager',
    description: 'Near-full operational access — orders, products, inventory, marketing, and customers.',
    permissions: [
      'home.view', 'orders.view', 'orders.export', 'orders.fulfill', 'orders.capture_payment',
      'orders.buy_shipping_label', 'orders.return', 'orders.abandoned_checkouts', 'orders.cancel',
      'orders.refund', 'orders.record_payment', 'orders.disputes_manage', 'draft_orders.view', 'draft_orders.mark_paid',
      'products.view', 'products.export', 'products.delete', 'products.edit', 'products.edit_price',
      'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'inventory.approve',
      'purchase_orders.manage', 'giftcards.view', 'giftcards.deactivate', 'customers.view', 'customers.export', 'customers.edit',
      'analytics.view', 'marketing.manage', 'discounts.manage', 'content.menus.manage', 'content.metaobjects.manage', 'files.manage',
      'onlinestore.themes.manage', 'onlinestore.content.manage',
      'settings.billing.view', 'settings.general.manage',
      'settings.shipping.manage', 'settings.locations.manage', 'settings.pixels.manage',
      'finance.payouts.view',
    ],
  },
  {
    name: 'Warehouse Staff',
    description: 'Inventory, purchase orders, and stock counts only.',
    permissions: ['inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'purchase_orders.manage'],
  },
  {
    name: 'Support Staff',
    description: 'View and fulfill orders, view customers.',
    permissions: ['home.view', 'orders.view', 'orders.fulfill', 'orders.return', 'customers.view'],
  },
];

@Injectable()
export class RoleService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.repos.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  /** Idempotent — only inserts a preset row if that exact name doesn't
   *  already exist for this store (a seller may have already renamed/
   *  deleted one, never resurrected). */
  private async ensurePresets(storeId: string) {
    const existing = await this.repos.roleModel.find({ storeId }).select('name').lean();
    const existingNames = new Set(existing.map((r: any) => r.name));
    const toCreate = PRESET_ROLES.filter((p) => !existingNames.has(p.name));
    if (toCreate.length === 0) return;
    await this.repos.roleModel.insertMany(toCreate.map((p) => ({ storeId, ...p, isPreset: true })));
  }

  async list(actorId: string, actorRole: string, storeId: string) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    await this.ensurePresets(storeId);
    return { success: true, data: await this.repos.roleModel.find({ storeId, isDelete: false }).sort({ isPreset: -1, name: 1 }).lean() };
  }

  async create(actorId: string, actorRole: string, storeId: string, dto: CreateRoleDto) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    const role = await this.repos.roleModel.create({ storeId, name: dto.name, description: dto.description ?? null, permissions: dto.permissions, isPreset: false });
    return { success: true, data: role };
  }

  async update(actorId: string, actorRole: string, storeId: string, roleId: string, dto: UpdateRoleDto) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    const role = await this.repos.roleModel.findOne({ _id: roleId, storeId, isDelete: false });
    if (!role) throw new NotFoundException('Role not found');
    if (dto.name !== undefined) role.name = dto.name;
    if (dto.description !== undefined) role.description = dto.description;
    if (dto.permissions !== undefined) role.permissions = dto.permissions as any;
    await role.save();

    // A role's own permission set changing must immediately affect every
    // staff member currently assigned to it — bump their tokenVersion so
    // an already-issued JWT (which embeds permissions at login time) can't
    // keep acting on the old, now-stale grant.
    await this.repos.staffMemberModel.updateMany({ storeId, roleId }, { $inc: { tokenVersion: 1 } });

    return { success: true, data: role.toObject() };
  }

  async remove(actorId: string, actorRole: string, storeId: string, roleId: string) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    const role = await this.repos.roleModel.findOne({ _id: roleId, storeId, isDelete: false });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isPreset) throw new BadRequestException('Preset roles cannot be deleted');
    const inUse = await this.repos.staffMemberModel.countDocuments({ storeId, roleId, isDelete: false });
    if (inUse > 0) throw new BadRequestException(`${inUse} staff member(s) are assigned to this role — reassign them first`);
    role.isDelete = true;
    await role.save();
    return { success: true, message: 'Role deleted' };
  }
}
