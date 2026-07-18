/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { DatabaseService } from 'src/database/databaseservice';

const MAX_BANNERS = 4;

@Injectable()
export class BannersService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get bannerModel() {
    return this.databaseService.repositories.bannerModel;
  }

  // ── GET ALL (public) ───────────────────────────────────────────────────────

  async findAll() {
    const banners = await this.bannerModel
      .find({ isActive: true })
      .sort({ order: 1, createdAt: 1 })
      .lean();

    return {
      success: true,
      count: banners.length,
      remaining: MAX_BANNERS - banners.length,
      data: banners,
    };
  }

  // ── GET COUNT (admin) ──────────────────────────────────────────────────────

  async getCount() {
    const count = await this.bannerModel.countDocuments({ isActive: true });

    return {
      success: true,
      data: {
        current: count,
        max: MAX_BANNERS,
        remaining: MAX_BANNERS - count,
        isFull: count >= MAX_BANNERS,
      },
    };
  }

  // ── CREATE FROM URL (admin) ────────────────────────────────────────────────

  async createFromUrl(dto: CreateBannerDto) {
    if (!dto.bannerImage) throw new BadRequestException('bannerImage URL is required');
    await this.checkLimit();

    const currentCount = await this.bannerModel.countDocuments({ isActive: true });

    const banner = await this.bannerModel.create({
      bannerImage: dto.bannerImage,
      publicId: '',
      urlOnTap: dto.urlOnTap || null,
      order: dto.order ?? currentCount,
      isActive: true,
    });

    return {
      success: true,
      message: 'Banner created successfully',
      remaining: MAX_BANNERS - (currentCount + 1),
      data: banner,
    };
  }

  // ── UPLOAD FILE (admin) ────────────────────────────────────────────────────

  async uploadBanner(file: Express.Multer.File, urlOnTap?: string) {
    await this.checkLimit();

    if (!file) throw new BadRequestException('No image file provided');

    const bannerImage = (file as any).path || '';
    const publicId = (file as any).filename || '';

    if (!bannerImage) throw new BadRequestException('Image upload to Cloudinary failed');

    const currentCount = await this.bannerModel.countDocuments({ isActive: true });

    const banner = await this.bannerModel.create({
      bannerImage,
      publicId,
      urlOnTap: urlOnTap || null,
      order: currentCount,
      isActive: true,
    });

    return {
      success: true,
      message: 'Banner uploaded successfully',
      remaining: MAX_BANNERS - (currentCount + 1),
      data: banner,
    };
  }

  // ── EDIT BANNER (admin) ────────────────────────────────────────────────────

  async updateBanner(bannerId: string, dto: UpdateBannerDto) {
    const banner = await this.bannerModel.findById(bannerId);
    if (!banner) throw new NotFoundException('Banner not found');

    const updated = await this.bannerModel.findByIdAndUpdate(
      bannerId,
      { $set: dto },
      { new: true, runValidators: true },
    );

    return {
      success: true,
      message: 'Banner updated successfully',
      data: updated,
    };
  }

  // ── DELETE BANNER (admin) ──────────────────────────────────────────────────

  async deleteBanner(bannerId: string) {
    const banner = await this.bannerModel.findById(bannerId);
    if (!banner) throw new NotFoundException('Banner not found');

    if (banner.publicId) {
      try {
        await cloudinary.uploader.destroy(banner.publicId);
      } catch (err) {
        console.warn('Could not delete from Cloudinary:', err.message);
      }
    }

    await this.bannerModel.deleteOne({ _id: bannerId });

    const remaining = await this.bannerModel.countDocuments({ isActive: true });

    return {
      success: true,
      message: 'Banner deleted successfully',
      remaining: MAX_BANNERS - remaining,
    };
  }

  // ── HELPER ─────────────────────────────────────────────────────────────────

  private async checkLimit() {
    const count = await this.bannerModel.countDocuments({ isActive: true });
    if (count >= MAX_BANNERS) {
      throw new BadRequestException(`Banner limit reached. Maximum ${MAX_BANNERS} banners allowed.`);
    }
  }
}
