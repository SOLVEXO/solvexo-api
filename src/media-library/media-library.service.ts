/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';

export interface MediaAssetUsage { type: string; label: string }

@Injectable()
export class MediaLibraryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
  ) {}

  private get model() {
    return this.databaseService.repositories.mediaAssetModel;
  }

  /** Uploads via the shared UploadService, then tracks the result for later
   *  reuse (the "choose existing" picker) — the real integration point that
   *  makes every image a seller uploads through `ImageUpload` (once it's
   *  given a `storeId`) land in that store's Files Library automatically. */
  async uploadAndTrack(
    file: Express.Multer.File,
    ownerType: 'admin' | 'seller',
    ownerId: string,
    options?: { folder?: string; maxDimension?: number; storeId?: string | null; altText?: string; tags?: string[] },
  ) {
    const uploaded = await this.uploadService.uploadFile(file, options);
    const asset = await this.model.create({
      ownerType,
      ownerId,
      storeId: options?.storeId ?? null,
      url: uploaded.url,
      publicId: uploaded.publicId,
      resourceType: uploaded.resourceType,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      sizeBytes: file.size ?? null,
      mimeType: file.mimetype ?? null,
      filename: file.originalname ?? '',
      altText: options?.altText ?? '',
      tags: options?.tags ?? [],
    });
    return { ...uploaded, mediaAssetId: asset._id };
  }

  async listForOwner(ownerType: 'admin' | 'seller', ownerId: string, limit = 60) {
    return this.model.find({ ownerType, ownerId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /** The real Files Library browse query — scoped to one store, with search/type/tag filters and pagination. */
  async listForStore(storeId: string, query: { search?: string; type?: 'image' | 'video'; tag?: string; page?: number; limit?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 40));
    const filter: Record<string, any> = { storeId };
    if (query.type) filter.resourceType = query.type;
    if (query.tag) filter.tags = query.tag;
    if (query.search?.trim()) {
      const re = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ filename: re }, { altText: re }, { tags: re }];
    }
    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  private async assertOwnedByStore(assetId: string, storeId: string) {
    const asset = await this.model.findOne({ _id: assetId, storeId }).lean();
    if (!asset) throw new NotFoundException('Asset not found in this store\'s library');
    return asset;
  }

  async updateMeta(storeId: string, assetId: string, patch: { altText?: string; tags?: string[] }) {
    await this.assertOwnedByStore(assetId, storeId);
    const update: Record<string, any> = {};
    if (patch.altText !== undefined) update.altText = patch.altText;
    if (patch.tags !== undefined) update.tags = patch.tags;
    return this.model.findByIdAndUpdate(assetId, { $set: update }, { new: true }).lean();
  }

  /** Real cross-collection usage lookup — not a maintained counter (which
   *  would drift as content changes elsewhere), a live check at the moment
   *  it matters (before a delete). Covers every structurally query-able
   *  image field plus a JS-side scan of the small, store-scoped
   *  Section/Block and Theme documents (their `settings`/color fields are
   *  loosely-typed `Record<string, any>` at the Mongoose layer, so a direct
   *  Mongo query can't reach into them generically). */
  async checkUsage(storeId: string, assetId: string): Promise<MediaAssetUsage[]> {
    const asset = await this.assertOwnedByStore(assetId, storeId);
    const url = asset.url;
    const repos = this.databaseService.repositories;
    const usages: MediaAssetUsage[] = [];

    const [products, categories, collections, store, banners, pages, theme] = await Promise.all([
      repos.productModel.find({ storeId, images: url }).select('name').lean(),
      repos.categoryModel.find({ image: url }).select('name').lean(),
      repos.collectionModel.find({ storeId, image: url }).select('name').lean(),
      repos.storeModel.findOne({ _id: storeId, $or: [{ logo: url }, { coverImage: url }] }).select('name').lean(),
      repos.storeBannerModel.find({ storeId, $or: [{ imageUrl: url }, { mobileImageUrl: url }] }).lean(),
      repos.storePageModel.find({ storeId }).select('title sections').lean(),
      repos.storeThemeModel.findOne({ storeId }).lean(),
    ]);

    for (const p of products as any[]) usages.push({ type: 'product', label: p.name });
    for (const c of categories as any[]) usages.push({ type: 'category', label: c.name });
    for (const c of collections as any[]) usages.push({ type: 'collection', label: c.name });
    if (store) usages.push({ type: 'store', label: 'Store profile (logo or cover image)' });
    for (let i = 0; i < banners.length; i++) usages.push({ type: 'banner', label: 'A storefront hero banner' });

    for (const p of pages as any[]) {
      if (JSON.stringify(p.sections ?? []).includes(url)) usages.push({ type: 'page', label: `Page "${p.title}"` });
    }
    if (theme) {
      const themeHit = JSON.stringify({ header: (theme as any).header, footer: (theme as any).footer, identityBanner: (theme as any).identityBanner, draft: (theme as any).draft }).includes(url);
      if (themeHit) usages.push({ type: 'theme', label: 'Theme header, footer, or identity banner' });
    }

    return usages;
  }

  async deleteAsset(storeId: string, assetId: string, force: boolean) {
    const asset = await this.assertOwnedByStore(assetId, storeId);
    if (!force) {
      const usage = await this.checkUsage(storeId, assetId);
      if (usage.length > 0) throw new ConflictException({ message: 'This file is still in use — remove it from these places first, or delete anyway.', usage });
    }
    await this.model.deleteOne({ _id: assetId });
    try {
      await this.uploadService.deleteFile(asset.publicId, asset.resourceType);
    } catch {
      // Best-effort — the library row is already gone either way; a stray
      // Cloudinary asset is a storage-cost nit, not a correctness issue.
    }
    return { publicId: asset.publicId, resourceType: asset.resourceType };
  }
}
