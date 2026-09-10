/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlockSettings } from '../common/store-content/section-settings.validator';
import { CreateMenuDto, UpdateMenuDto } from './dto/menu-item.dto';

const MAX_MENUS_PER_STORE = 20;
const MAX_ITEMS_PER_MENU = 50;

/** Reuses the exact same validation `nav_link` blocks already go through —
 *  a `MenuItem` is the identical shape, so there's no separate ruleset to
 *  keep in sync (max 8 children, no grandchildren, real link-type checks). */
function validateItems(items: Record<string, any>[]): void {
  if (items.length > MAX_ITEMS_PER_MENU) {
    throw new BadRequestException(`A menu cannot have more than ${MAX_ITEMS_PER_MENU} items`);
  }
  for (const item of items) validateBlockSettings('nav_link', item);
}

@Injectable()
export class MenusService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get menuModel() { return this.databaseService.repositories.menuModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  async list(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const menus = await this.menuModel.find({ storeId }).sort({ createdAt: 1 }).lean();
    return { success: true, data: menus };
  }

  async create(storeId: string, sellerId: string, dto: CreateMenuDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const count = await this.menuModel.countDocuments({ storeId });
    if (count >= MAX_MENUS_PER_STORE) throw new BadRequestException(`Cannot have more than ${MAX_MENUS_PER_STORE} menus`);
    const items = dto.items ?? [];
    validateItems(items);
    // Every item needs a stable id for reorder/edit even if the caller
    // (a brand-new menu built client-side) didn't assign one yet.
    const itemsWithIds = items.map(i => ({ ...i, id: i.id || new Types.ObjectId().toString() }));
    const created = await this.menuModel.create({ storeId, name: dto.name, items: itemsWithIds });
    return { success: true, message: 'Menu created', data: created };
  }

  async update(storeId: string, sellerId: string, menuId: string, dto: UpdateMenuDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.items !== undefined) {
      validateItems(dto.items);
      set.items = dto.items.map(i => ({ ...i, id: i.id || new Types.ObjectId().toString() }));
    }
    const updated = await this.menuModel.findOneAndUpdate({ _id: menuId, storeId }, { $set: set }, { new: true });
    if (!updated) throw new NotFoundException('Menu not found');
    return { success: true, message: 'Menu updated', data: updated };
  }

  async delete(storeId: string, sellerId: string, menuId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const menu = await this.menuModel.findOne({ _id: menuId, storeId });
    if (!menu) throw new NotFoundException('Menu not found');
    await menu.deleteOne();
    return { success: true, message: 'Menu deleted' };
  }

  /** Used internally by `StoreThemeService` to resolve a `menuId` attached
   *  to the Header into real items — not exposed as its own public route
   *  (the public storefront gets these already-resolved into the theme's
   *  own header payload, see that service). */
  async getRaw(storeId: string, menuId: string) {
    return this.menuModel.findOne({ _id: menuId, storeId }).lean();
  }
}
