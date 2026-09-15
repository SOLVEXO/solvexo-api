/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { DatabaseService } from '../database/databaseservice';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { MediaLibraryService } from '../media-library/media-library.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { validateCreativeDimensions } from '../common/validate-creative-dimensions.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { CreateStoreBannerDto } from './dto/create-store-banner.dto';
import { UpdateStoreBannerDto } from './dto/update-store-banner.dto';
import { StoreBannerStatus } from './schemas/store-banner.schema';
import { EntitlementsService } from '../platform-plans/entitlements.service';

// Master stored well above any real viewport (incl. retina/4K) — the frontend
// never fetches this directly, it requests per-breakpoint Cloudinary
// derivatives (see cloudinaryImage.ts), so a generous master costs nothing in
// visitor bandwidth, only Cloudinary storage.
const HERO_MAX_DIMENSION = 2560;
const HERO_MIN_SOURCE_WIDTH = 1280;

function computeInitialStatus(startAt?: string, endAt?: string): StoreBannerStatus {
  if (endAt && new Date(endAt).getTime() < Date.now()) {
    throw new BadRequestException('endAt is in the past');
  }
  if (startAt && new Date(startAt).getTime() > Date.now()) return 'scheduled';
  return 'active';
}

@Injectable()
export class StoreBannerService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminConfigService: AdminConfigService,
    private readonly mediaLibraryService: MediaLibraryService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get storeBannerModel() {
    return this.databaseService.repositories.storeBannerModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  private log(storeId: string, action: string, description: string, sellerId: string, targetId: string) {
    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action,
      description,
      actorId: sellerId,
      actorRole: 'seller',
      targetId,
      targetType: 'store_banner',
    });
  }

  // ── PUBLIC read (storefront) ────────────────────────────────────────────────

  async findActiveForStore(storeId: string) {
    const limit = await this.adminConfigService.getPlacementLimit('storeHero');
    const now = new Date();
    const banners = await this.storeBannerModel
      .find({
        storeId,
        status: 'active',
        // `status: 'active'` alone is only ever set once, at create/update
        // time (see computeInitialStatus) — nothing later flips it when a
        // banner's own `endAt` passes, so without this date check an expired
        // banner keeps showing on the live storefront indefinitely.
        $and: [
          { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
          { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
        ],
      })
      .sort({ priority: -1, order: 1 })
      .limit(limit)
      .lean();
    return { success: true, count: banners.length, data: banners };
  }

  // ── SELLER CRUD ──────────────────────────────────────────────────────────────

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const banners = await this.storeBannerModel.find({ storeId }).sort({ priority: -1, order: 1 }).lean();
    return { success: true, data: banners };
  }

  async create(storeId: string, sellerId: string, dto: CreateStoreBannerDto, file: Express.Multer.File | undefined) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    await this.entitlementsService.assertCanCreateStoreBanner(storeId);
    if (!file) throw new BadRequestException('A banner image is required');

    // Video Banners — the "Video" type needs an actual video file; every
    // other type stays image-only. Checked both ways so a mismatched
    // type/file pair fails loudly here instead of silently storing garbage.
    const fileIsVideo = file.mimetype.startsWith('video/');
    const wantsVideo = dto.type === 'video';
    if (wantsVideo && !fileIsVideo) {
      throw new BadRequestException('Video banners need a video file (e.g. .mp4/.webm) — please upload one, or pick a different banner type.');
    }
    if (!wantsVideo && fileIsVideo) {
      throw new BadRequestException('A video file was uploaded, but the banner type isn\'t "Video" — switch the type or upload an image instead.');
    }

    validateCreativeDimensions(file, 'storeHero');
    const uploaded = await this.mediaLibraryService.uploadAndTrack(file, 'seller', sellerId, {
      folder: 'uploads/store-banners',
      maxDimension: HERO_MAX_DIMENSION,
    });

    // The min-source-width guard only makes sense for a static image render
    // full-width — a video's own dimensions vary far more (vertical clips
    // included) and it's rendered `object-cover`, so it's skipped for video.
    if (!fileIsVideo && uploaded.width && uploaded.width < HERO_MIN_SOURCE_WIDTH) {
      await cloudinary.uploader.destroy(uploaded.publicId).catch(() => {});
      throw new BadRequestException(
        `Image is only ${uploaded.width}px wide — this banner renders full-width on desktop, so please upload at least ${HERO_MIN_SOURCE_WIDTH}px wide (recommended: 2560×720) to avoid blur.`,
      );
    }

    const status = computeInitialStatus(dto.startAt, dto.endAt);
    const currentCount = await this.storeBannerModel.countDocuments({ storeId });

    // For a video upload, `imageUrl` still gets populated — with a Cloudinary
    // -generated poster frame (no extra upload/storage: same publicId, just a
    // `.jpg` delivery of it) — so the seller's banner grid and the
    // storefront `<video poster>` both have a real thumbnail to show while
    // the clip itself loads/plays.
    const imageUrl = fileIsVideo
      ? cloudinary.url(uploaded.publicId, { resource_type: 'video', format: 'jpg', transformation: [{ width: HERO_MAX_DIMENSION, crop: 'limit' }] })
      : uploaded.url;

    const banner = await this.storeBannerModel.create({
      storeId,
      type: dto.type ?? 'hero',
      imageUrl,
      videoUrl: fileIsVideo ? uploaded.url : null,
      publicId: uploaded.publicId,
      ctaLabel: dto.ctaLabel ?? null,
      linkType: dto.linkType ?? 'external',
      linkTarget: dto.linkTarget ?? null,
      order: dto.order ?? currentCount,
      priority: dto.priority ?? 0,
      status,
      startAt: dto.startAt ?? null,
      endAt: dto.endAt ?? null,
      createdBy: sellerId,
    });

    this.log(storeId, 'store_banner_created', `Created a "${banner.type}" store banner`, sellerId, banner._id);
    return { success: true, message: 'Store banner created', data: banner };
  }

  private async findOwned(storeId: string, sellerId: string, bannerId: string) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const banner = await this.storeBannerModel.findOne({ _id: bannerId, storeId });
    if (!banner) throw new NotFoundException('Store banner not found');
    return banner;
  }

  async update(storeId: string, sellerId: string, bannerId: string, dto: UpdateStoreBannerDto) {
    await this.findOwned(storeId, sellerId, bannerId);

    const set: Record<string, unknown> = { ...dto };
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      set.status = computeInitialStatus(dto.startAt as string | undefined, dto.endAt as string | undefined);
    }

    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: set }, { new: true, runValidators: true });
    this.log(storeId, 'store_banner_updated', 'Updated a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner updated', data: updated };
  }

  async pause(storeId: string, sellerId: string, bannerId: string) {
    await this.findOwned(storeId, sellerId, bannerId);
    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: { status: 'paused' } }, { new: true });
    this.log(storeId, 'store_banner_paused', 'Paused a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner paused', data: updated };
  }

  async resume(storeId: string, sellerId: string, bannerId: string) {
    const banner = await this.findOwned(storeId, sellerId, bannerId);
    if (banner.endAt && banner.endAt.getTime() < Date.now()) {
      throw new BadRequestException('This banner already passed its end date — update endAt before resuming');
    }
    const updated = await this.storeBannerModel.findByIdAndUpdate(bannerId, { $set: { status: 'active' } }, { new: true });
    this.log(storeId, 'store_banner_resumed', 'Resumed a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner resumed', data: updated };
  }

  async remove(storeId: string, sellerId: string, bannerId: string) {
    const banner = await this.findOwned(storeId, sellerId, bannerId);

    // `banner.publicId` points at the video asset (not the poster — that's
    // just a derived `.jpg` delivery of the same publicId) when this was a
    // Video banner, so it must be destroyed with `resource_type: 'video'` or
    // Cloudinary's image-default destroy silently no-ops on it.
    const mainResourceType = banner.videoUrl ? 'video' : 'image';
    if (banner.publicId) {
      try {
        await cloudinary.uploader.destroy(banner.publicId, { resource_type: mainResourceType as any });
      } catch (err) {
        console.warn('Could not delete from Cloudinary:', err.message);
      }
    }

    await this.storeBannerModel.deleteOne({ _id: bannerId });
    this.log(storeId, 'store_banner_deleted', 'Deleted a store banner', sellerId, bannerId);
    return { success: true, message: 'Store banner deleted' };
  }

  async timeline(storeId: string, sellerId: string, bannerId: string) {
    await this.findOwned(storeId, sellerId, bannerId);
    return this.activityLogService.getTimeline(bannerId);
  }
}
