/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { SellerType, ProductType, resolveTools } from './schemas/store.schema';

@Injectable()
export class StoreService {
  constructor(private readonly databaseService: DatabaseService) {}

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
}