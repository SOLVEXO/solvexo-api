import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';

import { DatabaseService } from '@/database/databaseservice';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { generateUniqueSlug } from '@/common/slug.util';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';

@Injectable()
export class CategoriesService {
  constructor(private readonly databaseService: DatabaseService) {}

  async addCategory(
    userId: string,
    role: string,
    createCategoryDto: CreateCategoryDto,
  ) {
    // ADMIN CHECK
    if (role === 'admin') {
      const admin = await this.databaseService.repositories.adminModel.findOne({
        _id: userId,
        status: 'active',
        isDelete: false,
      });

      if (!admin) {
        throw new UnauthorizedException('Unauthorized admin');
      }
    }

    // SELLER CHECK
    if (role === 'seller') {
      const seller =
        await this.databaseService.repositories.sellerModel.findOne({
          _id: userId,
          status: 'active',
          isDelete: false,
        });

      if (!seller) {
        throw new UnauthorizedException('Unauthorized seller');
      }
    }

    try {
      const { name, parentId, image, description, sortOrder, storeId } =
        createCategoryDto;
      const categoryModel = this.databaseService.repositories.categoryModel;

      let parent: any = null;

      if (storeId) {
        // 🔒 Store-scoped category — a seller building their OWN store's
        // category tree, entirely at their own discretion: unlike the
        // legacy global taxonomy below, both main categories AND
        // subcategories are allowed freely here, no admin gate. Still
        // capped at 2 levels (main → sub), and a subcategory's parent must
        // belong to this same store.
        if (role !== 'seller') {
          throw new ForbiddenException('Only a seller can create a category for their own store');
        }
        await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, userId);

        if (parentId) {
          if (!isValidObjectId(parentId)) {
            throw new BadRequestException('Parent category not found');
          }
          parent = await categoryModel.findOne({
            _id: parentId,
            storeId,
            status: 'active',
            isDelete: false,
          });
          if (!parent) {
            throw new BadRequestException('Parent category not found');
          }
          if (parent.parentId) {
            throw new BadRequestException(
              'Categories can only be nested one level deep — pick a main category as the parent',
            );
          }
        }

        const existingCategory = await categoryModel.findOne({
          name,
          storeId,
          parentId: parentId ?? null,
          status: 'active',
          isDelete: false,
        });
        if (existingCategory) {
          throw new ConflictException('You already have a category with this name here');
        }

        const slug = await generateUniqueSlug(categoryModel, name);
        const category = await categoryModel.create({
          name,
          slug,
          parentId: parentId ?? null,
          storeId,
          image: image,
          description: description,
          sortOrder: sortOrder || 0,
          createdBy: userId,
          createdByRole: role,
        });

        return {
          success: true,
          message: 'Category created successfully',
          data: category,
        };
      }

      // 🔒 Legacy global/admin taxonomy — unchanged behavior:
      // - Main categories (no parentId) → admin only. This is the curated
      //   top-level taxonomy the public Marketplace still browses by.
      // - Subcategories (parentId set) → admin OR seller, optionally, and
      //   only nested one level under an existing main category (no
      //   sub-of-a-sub — keeps the tree exactly 2 levels deep).
      if (!parentId) {
        if (role !== 'admin') {
          throw new ForbiddenException(
            'Only admins can create main categories',
          );
        }
      } else {
        // A malformed `parentId` (found via a live QA pass: a corrupted
        // `Store.categoryId` value was a category NAME string, not a real
        // ObjectId) must be rejected cleanly here — without this guard,
        // Mongoose throws a raw CastError whose message names the exact
        // model/field/driver internals, which the catch block below would
        // otherwise forward verbatim to the client.
        if (!isValidObjectId(parentId)) {
          throw new BadRequestException('Parent category not found');
        }
        parent = await categoryModel.findOne({
          _id: parentId,
          status: 'active',
          isDelete: false,
        });
        if (!parent) {
          throw new BadRequestException('Parent category not found');
        }
        if (parent.parentId) {
          throw new BadRequestException(
            'Categories can only be nested one level deep — pick a main category as the parent',
          );
        }
      }

      // check duplicate category — scoped to the same parent, so the same
      // name can exist under different main categories without colliding.
      const existingCategory = await categoryModel.findOne({
        name,
        parentId: parentId ?? null,
        status: 'active',
        isDelete: false,
      });

      if (existingCategory) {
        throw new ConflictException(
          'A category with this name already exists here',
        );
      }

      const slug = await generateUniqueSlug(categoryModel, name);

      const category = await categoryModel.create({
        name,
        slug,
        parentId: parentId ?? null,
        image: image,
        description: description,
        sortOrder: sortOrder || 0,
        createdBy: userId,
        createdByRole: role,
      });

      return {
        success: true,
        message: 'Category created successfully',
        data: category,
      };
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      // Never forward a raw driver/ORM exception message (model name, field
      // name, cast-error internals) to the client — found leaking verbatim
      // in a live QA pass via this exact fallback. Log the real error
      // server-side for debugging; the client gets a safe, generic message.
      console.error('CategoriesService.addCategory failed:', error);
      throw new BadRequestException('Failed to create category');
    }
  }

  // async getChildCategories(parentId: string) {

  //   const categoryModel = this.databaseService.repositories.categoryModel;

  //   const children = await categoryModel.find({ parentId });

  //  let ids: string[] = [];

  // for (let child of children) {

  //   ids.push(child._id.toString());

  //   const subChildren = await this.getChildCategories(child._id.toString());

  //   ids = ids.concat(subChildren);

  // }

  //   return ids;
  // }

  // async getCategoryTree(categoryId: string) {

  //   const categoryModel = this.databaseService.repositories.categoryModel;

  //   // parent category
  //   const parentCategory = await categoryModel.findById(categoryId);

  //   if (!parentCategory) {
  //     throw new UnauthorizedException('Category not found');
  //   }

  //   // saare child ids
  //   const childIds = await this.getChildCategories(categoryId);

  //   // parent + child
  //   const allIds = [categoryId, ...childIds];

  //   // saari categories ka data
  //   const categories = await categoryModel.find({
  //     _id: { $in: allIds }
  //   });

  //   return {
  //     message: "Category tree fetched successfully",
  //     data: categories
  //   };
  // }

  /** `storeId` scopes the tree to one store's own privately-created
   *  categories only (used by that store's product forms, Categories page,
   *  and every builder category-picker) — omitted, this is the legacy
   *  global/admin tree (Marketplace, admin curation, SEO/sitemap). The two
   *  never mix: a store-scoped call only ever sees rows with that exact
   *  `storeId`, never legacy/global rows or another store's rows. */
  async getCategoryTreeNested(categoryId?: string, storeId?: string) {
    const categoryModel = this.databaseService.repositories.categoryModel;

    const countMap = await this.getActiveProductCountsByCategory();

    // 🔹 CASE 1: agar id di hui hai
    if (categoryId) {
      // A non-ObjectId string (e.g. a category name leaking in from stale
      // data) would otherwise throw an unhandled Mongoose CastError here,
      // which Nest surfaces as an opaque 500 — fail with a clear 400 instead.
      if (!isValidObjectId(categoryId)) {
        throw new BadRequestException('Invalid category id');
      }

      const category = await categoryModel.findOne({
        _id: categoryId,
        status: 'active',
        isDelete: false,
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }

      const children = await this.getChildrenRecursive(categoryId);
      const node = { ...category.toObject(), children };
      await this.ensureSlug(node);
      this.attachProductCounts([node], countMap);

      return {
        success: true,
        message: 'Category tree fetched successfully',
        data: node,
      };
    }

    // 🔹 CASE 2: agar id NA ho → root categories lao (this store's own, if
    // `storeId` was given — else the legacy global/admin roots, unchanged).
    const rootCategories = await categoryModel
      .find({
        parentId: null,
        storeId: storeId ?? null,
        status: 'active',
        isDelete: false,
      })
      .lean();

    const result: any[] = [];

    for (const cat of rootCategories) {
      await this.ensureSlug(cat);
      const children = await this.getChildrenRecursive(cat._id.toString());

      result.push({
        ...cat,
        children,
      });
    }

    this.attachProductCounts(result, countMap);

    return {
      success: true,
      message: 'All category trees fetched successfully',
      data: result,
    };
  }

  /** One aggregation over all buyer-visible products, grouped by category — the
   *  building block `attachProductCounts` uses instead of a per-node query. */
  private async getActiveProductCountsByCategory(): Promise<Map<string, number>> {
    const productModel = this.databaseService.repositories.productModel;
    const rows = await productModel.aggregate([
      { $match: { status: 'active', isDelete: false } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r: { _id: string; count: number }) => [r._id, r.count]));
  }

  /** Mutates each node (and its nested `children`) in place, setting
   *  `productCount` to that category's own direct products plus every
   *  descendant's — so a parent category's chip reflects its whole subtree. */
  private attachProductCounts(nodes: any[], countMap: Map<string, number>): number {
    let total = 0;
    for (const node of nodes) {
      const ownCount = countMap.get(String(node._id)) ?? 0;
      const childrenCount = node.children?.length
        ? this.attachProductCounts(node.children, countMap)
        : 0;
      node.productCount = ownCount + childrenCount;
      total += node.productCount;
    }
    return total;
  }
  private async getChildrenRecursive(parentId: string): Promise<any[]> {
    const categoryModel = this.databaseService.repositories.categoryModel;

    const children = await categoryModel.find({
      parentId,
      status: 'active',
      isDelete: false,
    });

    const result: any[] = [];

    for (const child of children) {
      const childObj = child.toObject();
      await this.ensureSlug(childObj);
      const subChildren = await this.getChildrenRecursive(childObj._id.toString());

      result.push({
        ...childObj,
        children: subChildren, // nested inside each child
      });
    }

    return result;
  }

  /** Lazily backfills a permanent, persisted slug for any pre-migration
   *  category found without one — mutates the plain object in place and
   *  writes it to the DB so it's stable from then on (never recomputed). */
  private async ensureSlug(cat: any): Promise<void> {
    if (cat.slug) return;
    const categoryModel = this.databaseService.repositories.categoryModel;
    const slug = await generateUniqueSlug(categoryModel, cat.name, {
      excludeId: String(cat._id),
    });
    await categoryModel.findByIdAndUpdate(cat._id, { slug });
    cat.slug = slug;
  }

  async getCategoryWithChildren(categoryId: string, storeId?: string): Promise<any> {
    const categoryModel = this.databaseService.repositories.categoryModel;

    if (!isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category id');
    }

    // Parent category (only active & not deleted) — scoped to this store
    // when one is given, same as the category-tree endpoint.
    const category = await categoryModel.findOne({
      _id: categoryId,
      ...(storeId ? { storeId } : {}),
      status: 'active',
      isDelete: false,
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Direct children (only active & not deleted)
    const children = await categoryModel.find({
      parentId: categoryId,
      status: 'active',
      isDelete: false,
    });

    return {
      success: true,
      message: 'Category with children fetched successfully',
      data: {
        category, // parent category
        children, // flat array of direct children
      },
    };
  }

  /** Rename/re-describe/re-image/toggle-active a seller's OWN store-owned
   *  category. The legacy/global admin taxonomy has no rename path — this
   *  never touches a category with `storeId: null`. Slug is deliberately
   *  left untouched on rename (unlike Product, which does regenerate its
   *  slug on rename and — per that code's own comment — breaks previously
   *  shared links as a result): a category's slug backs the real public
   *  `/category/:slugOrId` storefront route, so keeping it stable avoids
   *  reintroducing that same class of broken-link bug here. */
  async updateCategory(
    userId: string,
    storeId: string,
    categoryId: string,
    dto: UpdateCategoryDto,
  ): Promise<any> {
    if (!storeId) {
      throw new BadRequestException('storeId is required');
    }
    if (!isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category id');
    }
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, userId);

    const categoryModel = this.databaseService.repositories.categoryModel;
    const category = await categoryModel.findOne({ _id: categoryId, storeId, isDelete: false });
    if (!category) {
      throw new NotFoundException('Category not found');
    }

    if (dto.name !== undefined && dto.name !== category.name) {
      const duplicate = await categoryModel.findOne({
        _id: { $ne: categoryId },
        name: dto.name,
        storeId,
        parentId: category.parentId,
        status: 'active',
        isDelete: false,
      });
      if (duplicate) {
        throw new ConflictException('You already have a category with this name here');
      }
      category.name = dto.name;
    }
    if (dto.description !== undefined) category.description = dto.description;
    if (dto.image !== undefined) category.image = dto.image;
    if (dto.isActive !== undefined) category.status = dto.isActive ? 'active' : 'inactive';

    await category.save();

    return {
      success: true,
      message: 'Category updated successfully',
      data: category,
    };
  }

  /** Soft-deletes a seller's own store-owned category — blocked (with a
   *  clear reason) if any active product still references it, or if it's a
   *  main category with active subcategories still under it, so a delete
   *  can never silently orphan real catalog data. */
  async deleteCategory(userId: string, storeId: string, categoryId: string): Promise<any> {
    if (!storeId) {
      throw new BadRequestException('storeId is required');
    }
    if (!isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category id');
    }
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, userId);

    const categoryModel = this.databaseService.repositories.categoryModel;
    const category = await categoryModel.findOne({ _id: categoryId, storeId, isDelete: false });
    if (!category) {
      throw new NotFoundException('Category not found');
    }

    const childCount = await categoryModel.countDocuments({
      parentId: categoryId,
      status: 'active',
      isDelete: false,
    });
    if (childCount > 0) {
      throw new ConflictException('Remove or move this category\'s subcategories before deleting it');
    }

    const productModel = this.databaseService.repositories.productModel;
    const productCount = await productModel.countDocuments({
      storeId,
      isDelete: false,
      $or: [{ categoryId }, { subCategoryId: categoryId }],
    });
    if (productCount > 0) {
      throw new ConflictException(
        `${productCount} product${productCount === 1 ? '' : 's'} still use this category — reassign them first`,
      );
    }

    category.isDelete = true;
    category.status = 'inactive';
    await category.save();

    return {
      success: true,
      message: 'Category deleted successfully',
    };
  }

  async getAllCategories(): Promise<any> {
    const categoryModel = this.databaseService.repositories.categoryModel;

    // sirf active aur not deleted categories
    const categories = await categoryModel.find({
      status: 'active',
      isDelete: false,
    });

    return {
      success: true,
      message: 'All categories fetched successfully',
      data: categories,
    };
  }
}
