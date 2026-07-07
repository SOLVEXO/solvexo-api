/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { SellerType, ProductType, resolveTools } from './schemas/store.schema';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { UpdateStoreCustomerDto } from './dto/update-store-customer.dto';

@Injectable()
export class StoreService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  async createStore(sellerId: string, body: any) {
    const { name, logo, categoryId, description, sellerType, productTypes } = body;

    if (!name) throw new BadRequestException('Store name is required');

    if (sellerType && !Object.values(SellerType).includes(sellerType)) {
      throw new BadRequestException('Invalid sellerType');
    }

    if (productTypes && Array.isArray(productTypes)) {
      const validTypes = Object.values(ProductType);
      for (const pt of productTypes) {
        if (!validTypes.includes(pt)) {
          throw new BadRequestException(`Invalid productType: ${pt}`);
        }
      }
    }

    // ✅ multiple stores allowed — koi "already have a store" check nahi

    const baseSlug = this.generateSlug(name);
    let slug = baseSlug;
    let count = 1;

    while (await this.databaseService.repositories.storeModel.findOne({ slug })) {
      slug = `${baseSlug}-${count}`;
      count++;
    }

    const finalProductTypes = productTypes ?? [];

    const store = await this.databaseService.repositories.storeModel.create({
      sellerId,
      name,
      slug,
      logo: logo ?? null,
      categoryId: categoryId ?? null,
      description: description ?? null,
      sellerType: sellerType ?? null,
      productTypes: finalProductTypes,
      enabledTools: resolveTools(finalProductTypes),
    });

    // ✅ seller pe sirf onboarded mark — storeId nahi rakhte (source of truth = Store.sellerId)
    await this.databaseService.repositories.sellerModel.findByIdAndUpdate(sellerId, {
      isOnboarded: true,
    });

    return {
      success: true,
      message: 'Store created successfully',
      data: store,
    };
  }

  // seller ke saare stores
  async getMyStores(sellerId: string) {
    const stores = await this.databaseService.repositories.storeModel
      .find({ sellerId, isDelete: false })
      .lean();

    const seller = await this.databaseService.repositories.sellerModel
      .findById(sellerId)
      .select('name email')
      .lean();

    const data = stores.map((store) => ({
      ...store,
      sellerName: seller?.name ?? null,
      sellerEmail: seller?.email ?? null,
    }));

    return {
      success: true,
      count: data.length,
      data,
    };
  }

  async getStoreById(storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    return {
      success: true,
      data: store,
    };
  }

  // ✅ ab storeId se update hota hai (multiple stores ke liye zaroori)
  async updateStore(sellerId: string, storeId: string, body: any) {
    const { name, logo, description, sellerType, productTypes, status } = body;

    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    if (store.sellerId !== sellerId)
      throw new UnauthorizedException('You are not authorized to edit this store');

    if (sellerType && !Object.values(SellerType).includes(sellerType)) {
      throw new BadRequestException('Invalid sellerType');
    }

    if (productTypes && Array.isArray(productTypes)) {
      const validTypes = Object.values(ProductType);
      for (const pt of productTypes) {
        if (!validTypes.includes(pt)) {
          throw new BadRequestException(`Invalid productType: ${pt}`);
        }
      }
    }

    const updateData: any = {};

    if (name && name !== store.name) {
      const baseSlug = this.generateSlug(name);
      let slug = baseSlug;
      let count = 1;
      while (
        await this.databaseService.repositories.storeModel.findOne({ slug, _id: { $ne: store._id } })
      ) {
        slug = `${baseSlug}-${count}`;
        count++;
      }
      updateData.name = name;
      updateData.slug = slug;
    }

    if (logo !== undefined) updateData.logo = logo;
    if (description !== undefined) updateData.description = description;
    if (sellerType !== undefined) updateData.sellerType = sellerType;

    // productTypes change ho to enabledTools bhi refresh
    if (productTypes !== undefined) {
      updateData.productTypes = productTypes;
      updateData.enabledTools = resolveTools(productTypes);
    }

    if (status !== undefined) updateData.status = status;
    if (body.categoryId !== undefined) updateData.categoryId = body.categoryId;

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      store._id,
      updateData,
      { new: true },
    );

    return {
      success: true,
      message: 'Store updated successfully',
      data: updated,
    };
  }

  // ── 1. Save builder config ────────────────────────────────────────────────
  async saveBuilderConfig(sellerId: string, body: any) {
    const { storeId, builderConfig, coverImage } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!builderConfig) throw new BadRequestException('builderConfig is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const updateData: any = { builderConfig };
    if (coverImage !== undefined) updateData.coverImage = coverImage;

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      storeId,
      updateData,
      { new: true },
    );

    return { success: true, message: 'Builder config saved', data: updated };
  }

  // ── 2. Get builder config ─────────────────────────────────────────────────
  async getBuilderConfig(sellerId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    }).lean();
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    return {
      success: true,
      data: {
        builderConfig: store.builderConfig ?? null,
        coverImage: store.coverImage ?? null,
        storeName: store.name,
        description: store.description,
      },
    };
  }

  // ── 3. Public store by slug ───────────────────────────────────────────────
  async getPublicStore(slug: string) {
    if (!slug) throw new BadRequestException('slug is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      slug,
      isDelete: false,
      status: 'active',
    }).lean();
    if (!store) throw new NotFoundException('Store not found');

    return {
      success: true,
      data: {
        storeId: store._id,
        sellerId: store.sellerId,
        name: store.name,
        slug: store.slug,
        logo: store.logo,
        coverImage: store.coverImage ?? null,
        description: store.description,
        followersCount: store.followersCount ?? 0,
        builderConfig: store.builderConfig ?? null,
        sellerType: (store as any).sellerType ?? null,
        badges: (store as any).badges ?? [],
      },
    };
  }

  // ── 4. Public store products ──────────────────────────────────────────────
  async getPublicStoreProducts(storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
      status: 'active',
    }).lean();
    if (!store) throw new NotFoundException('Store not found');

    const page  = parseInt(query.page)  || 1;
    const limit = parseInt(query.limit) || 12;
    const skip  = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false, status: 'active' };
    if (query.type && query.type !== 'all') filter.type = query.type;
    if (query.categoryId && query.categoryId !== 'all') filter.categoryId = query.categoryId;
    if (query.tag && query.tag !== 'all') filter.tags = query.tag;

    const sortMap: Record<string, any> = {
      newest:     { createdAt: -1 },
      price_asc:  { 'variants.price': 1 },
      price_desc: { 'variants.price': -1 },
      best_rated: { averageRating: -1 },
      default:    { createdAt: -1 },
    };
    const sort = sortMap[query.sort] ?? sortMap['default'];

    const total    = await this.databaseService.repositories.productModel.countDocuments(filter);
    const products = await this.databaseService.repositories.productModel
      .find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        products,
      },
    };
  }

  // ── 5. Public store filters (tags) ───────────────────────────────────────
  async getPublicStoreFilters(storeId: string) {
    const productModel = this.databaseService.repositories.productModel;
    const tags: string[] = await productModel.distinct('tags', {
      storeId,
      isDelete: false,
      status: 'active',
    });
    return {
      success: true,
      data: { tags: tags.filter(Boolean).sort() },
    };
  }

  // ── 6. Follow / Unfollow store ────────────────────────────────────────────
  async followStore(userId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });
    if (!store) throw new NotFoundException('Store not found');

    const existing = await this.databaseService.repositories.storeFollowerModel.findOne({
      userId,
      storeId,
    });

    if (existing) {
      await this.databaseService.repositories.storeFollowerModel.deleteOne({ userId, storeId });
      await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, {
        $inc: { followersCount: -1 },
      });
      return { success: true, message: 'Unfollowed', following: false };
    }

    await this.databaseService.repositories.storeFollowerModel.create({ userId, storeId });
    await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, {
      $inc: { followersCount: 1 },
    });
    return { success: true, message: 'Following', following: true };
  }

  // ── 7. Get store followers (seller only) ─────────────────────────────────
  async getStoreFollowers(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    }).lean();
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const page  = parseInt(query.page)  || 1;
    const limit = parseInt(query.limit) || 20;
    const skip  = (page - 1) * limit;

    const total = await this.databaseService.repositories.storeFollowerModel
      .countDocuments({ storeId });

    const followers = await this.databaseService.repositories.storeFollowerModel
      .find({ storeId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const userIds = followers.map((f) => f.userId);
    const users = await this.databaseService.repositories.userModel
      .find({ _id: { $in: userIds } })
      .select('name email profileImage')
      .lean();

    const userMap: Record<string, any> = {};
    users.forEach((u: any) => { userMap[u._id.toString()] = u; });

    const data = followers.map((f) => ({
      followedAt: (f as any).createdAt,
      user: userMap[f.userId] ?? { _id: f.userId, name: 'Unknown' },
    }));

    return {
      success: true,
      data: {
        total,
        pagination: { page, limit, totalPages: Math.ceil(total / limit) },
        followers: data,
      },
    };
  }

  // ── 6. Get follow status ──────────────────────────────────────────────────
  async getFollowStatus(userId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const existing = await this.databaseService.repositories.storeFollowerModel.findOne({
      userId,
      storeId,
    }).lean();

    return {
      success: true,
      data: { following: !!existing },
    };
  }

  // ── 7. Store customers (staff-facing: only people who have ordered from this store) ────

  async getStoreCustomers(sellerId: string, storeId: string, query: any) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to view this store\'s customers');

    const { orderModel, userModel } = this.databaseService.repositories;

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const customerIds = await orderModel.distinct('userId', { 'sellerOrders.storeId': storeId, isDelete: false });
    const total = customerIds.length;
    const pageIds = customerIds.slice(skip, skip + limit);

    const customers = await userModel.find({ _id: { $in: pageIds } }).select('name email phone createdAt').lean();

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        customers,
      },
    };
  }

  async updateStoreCustomer(
    sellerId: string,
    storeId: string,
    customerId: string,
    dto: UpdateStoreCustomerDto,
    ip?: string,
    userAgent?: string,
  ) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to edit this store\'s customers');

    const { orderModel, userModel } = this.databaseService.repositories;

    const hasOrderedHere = await orderModel.exists({ userId: customerId, 'sellerOrders.storeId': storeId, isDelete: false });
    if (!hasOrderedHere) throw new BadRequestException('This customer has no orders with your store');

    const update: any = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.phone !== undefined) update.phone = dto.phone;
    if (dto.email !== undefined) {
      update.email = dto.email;
      update.isVerified = false; // new email hasn't gone through OTP yet
    }

    if (Object.keys(update).length === 0) throw new BadRequestException('Nothing to update');

    const customer = await userModel
      .findByIdAndUpdate(customerId, update, { new: true, runValidators: true })
      .select('-password -otp -otpExpiresAt');

    if (!customer) throw new NotFoundException('Customer not found');

    this.activityLogService.log({
      storeId,
      category: 'customers',
      action: 'customer_profile_updated',
      description: `${(customer as any).name} — updated ${Object.keys(update).filter((k) => k !== 'isVerified').join(', ')}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: customerId,
      targetType: 'customer',
      ip,
      userAgent,
    });

    return { success: true, message: 'Customer updated', data: customer };
  }
}