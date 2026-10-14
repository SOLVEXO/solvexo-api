/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { STAFF_PERMISSIONS } from './schemas/staff-member.schema';

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
      'orders.buy_shipping_label', 'orders.return', 'orders.abandoned_checkouts', 'orders.cancel', 'orders.edit',
      'orders.refund', 'orders.record_payment', 'orders.disputes_manage', 'draft_orders.view', 'draft_orders.mark_paid',
      'products.view', 'products.export', 'products.delete', 'products.edit', 'products.edit_price',
      'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'inventory.approve',
      'purchase_orders.manage', 'giftcards.view', 'giftcards.deactivate', 'customers.view', 'customers.export', 'customers.edit',
      'analytics.view', 'marketing.manage', 'discounts.manage', 'content.menus.manage', 'content.metaobjects.manage', 'files.manage',
      'onlinestore.themes.manage', 'onlinestore.content.manage',
      'settings.billing.view', 'settings.general.manage',
      'settings.shipping.manage', 'settings.locations.manage', 'settings.pixels.manage',
      'finance.payouts.view',
      // Messaging/Loyalty/Subscriptions/SEO/AI Studio — added once these 5
      // modules gained real staff-permission gates; all fit this preset's
      // existing "near-full operational access" scope the same way
      // marketing.manage/discounts.manage/onlinestore.content.manage
      // already do (customer-facing/marketing-adjacent tools, not
      // financial/ownership-level access).
      'messaging.view', 'messaging.manage',
      'loyalty.view', 'loyalty.manage', 'loyalty.points.award',
      'seo.view', 'seo.manage',
      'aistudio.view', 'aistudio.use',
      // Added with PRESET_VERSION 1
      'products.create', 'collections.manage', 'categories.manage', 'draft_orders.manage', 'reviews.manage', 'activity_log.view',
    ],
  },
  {
    name: 'Warehouse Staff',
    description: 'Inventory, purchase orders, and stock counts only.',
    permissions: ['inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'purchase_orders.manage'],
  },
  {
    name: 'Support Staff',
    description: 'View and fulfill orders, view customers, and reply to customer messages.',
    permissions: ['home.view', 'orders.view', 'orders.fulfill', 'orders.return', 'customers.view', 'messaging.view', 'messaging.manage', 'reviews.manage'],
  },
];

/** Bump when PRESET_ROLES gains permissions; list what each preset gets in PRESET_ADDITIONS for that version. */
const PRESET_VERSION = 1;
const PRESET_ADDITIONS: Record<number, Record<string, string[]>> = {
  1: {
    'Store Manager': ['products.create', 'collections.manage', 'categories.manage', 'draft_orders.manage', 'reviews.manage', 'activity_log.view'],
    'Support Staff': ['reviews.manage'],
  },
};

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

  /** Roles saved before a permission was retired (e.g. buyer subscriptions) still
   *  carry its key, which would make every later Save fail validation. Strip
   *  them from the stored role (and the rows handed back) the first time the
   *  store's roles are listed. */
  private async pruneRetiredPermissions(roles: any[]) {
    const known = STAFF_PERMISSIONS as readonly string[];
    for (const role of roles) {
      const clean = (role.permissions ?? []).filter((p: string) => known.includes(p));
      if (clean.length === (role.permissions ?? []).length) continue;
      role.permissions = clean;
      await this.repos.roleModel.updateOne({ _id: role._id }, { $set: { permissions: clean } });
    }
  }

  /** Idempotent — only inserts a preset row if that exact name doesn't
   *  already exist for this store (a seller may have already renamed/
   *  deleted one, never resurrected). */
  private async ensurePresets(storeId: string) {
    const existing = await this.repos.roleModel.find({ storeId }).select('name isPreset presetVersion permissions').lean();
    const existingNames = new Set(existing.map((r: any) => r.name));
    const toCreate = PRESET_ROLES.filter((p) => !existingNames.has(p.name));
    if (toCreate.length > 0) {
      await this.repos.roleModel.insertMany(toCreate.map((p) => ({ storeId, ...p, isPreset: true, presetVersion: PRESET_VERSION })));
    }
    // Presets created before a newer permission existed absorb it ONCE (set union), never removing what the owner customised.
    for (const row of existing as any[]) {
      if (!row.isPreset || (row.presetVersion ?? 0) >= PRESET_VERSION) continue;
      const add = new Set<string>();
      for (let v = (row.presetVersion ?? 0) + 1; v <= PRESET_VERSION; v++) for (const k of PRESET_ADDITIONS[v]?.[row.name] ?? []) add.add(k);
      const merged = Array.from(new Set([...(row.permissions ?? []), ...add]));
      await this.repos.roleModel.updateOne({ _id: row._id }, { $set: { permissions: merged, presetVersion: PRESET_VERSION } });
      // Their already-issued tokens carry the old list: refresh on next login.
      await this.repos.staffMemberModel.updateMany({ storeId, roleId: String(row._id) }, { $inc: { tokenVersion: 1 } });
    }
  }

  async list(actorId: string, actorRole: string, storeId: string) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    await this.ensurePresets(storeId);
    const roles: any[] = await this.repos.roleModel.find({ storeId, isDelete: false }).sort({ isPreset: -1, name: 1 }).lean();
    await this.pruneRetiredPermissions(roles);
    return { success: true, data: roles };
  }

  /** A staff actor (never a seller/admin) can only create/edit/delete a Role
   *  whose permissions are ALL ones they hold themselves — otherwise a
   *  `staff.manage` holder could simply grant themselves everything. */
  private assertSubsetOfActor(actorRole: string, actorPermissions: string[] | null, perms: string[]) {
    if (actorRole !== 'staff') return;
    const disallowed = perms.filter((p) => !(actorPermissions ?? []).includes(p));
    if (disallowed.length > 0) throw new ForbiddenException(`You can't grant permissions you don't have: ${disallowed.join(', ')}`);
  }

  async create(actorId: string, actorRole: string, storeId: string, dto: CreateRoleDto, actorPermissions: string[] | null = null) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    this.assertSubsetOfActor(actorRole, actorPermissions, dto.permissions ?? []);
    const role = await this.repos.roleModel.create({ storeId, name: dto.name, description: dto.description ?? null, permissions: dto.permissions, isPreset: false });
    return { success: true, data: role };
  }

  async update(actorId: string, actorRole: string, storeId: string, roleId: string, dto: UpdateRoleDto, actorPermissions: string[] | null = null) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    const role = await this.repos.roleModel.findOne({ _id: roleId, storeId, isDelete: false });
    if (!role) throw new NotFoundException('Role not found');
    this.assertSubsetOfActor(actorRole, actorPermissions, [...((role as any).permissions ?? []), ...(dto.permissions ?? [])]);
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

  async remove(actorId: string, actorRole: string, storeId: string, roleId: string, actorPermissions: string[] | null = null) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    const role = await this.repos.roleModel.findOne({ _id: roleId, storeId, isDelete: false });
    if (!role) throw new NotFoundException('Role not found');
    this.assertSubsetOfActor(actorRole, actorPermissions, (role as any).permissions ?? []);
    if (role.isPreset) throw new BadRequestException('Preset roles cannot be deleted');
    const inUse = await this.repos.staffMemberModel.countDocuments({ storeId, roleId, isDelete: false });
    if (inUse > 0) throw new BadRequestException(`${inUse} staff member(s) are assigned to this role — reassign them first`);
    role.isDelete = true;
    await role.save();
    return { success: true, message: 'Role deleted' };
  }
}
