import {
    Injectable,
    BadRequestException,
    NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { CreateBannerDto } from './dto/create-banner.dto'
import { Banner, BannerDocument } from './schemas/banner.schema';

const MAX_BANNERS = 4;

@Injectable()
export class BannersService {
    constructor(
        @InjectModel(Banner.name)
        private bannerModel: Model<BannerDocument>,
    ) { }
    async createFromUrl(dto: CreateBannerDto) {
        await this.checkLimit();

        if (!dto.imageUrl) {
            throw new BadRequestException('Please provide imageUrl in the body');
        }

        return this.saveBanner(dto.imageUrl, '');
    }

    private async saveBanner(imageUrl: string, publicId: string) {
        const currentCount = await this.bannerModel
            .countDocuments({ isActive: true })
            .exec();

        const banner = await this.bannerModel.create({
            imageUrl,
            publicId,
            order: currentCount,
            isActive: true,
        });

        return {
            success: true,
            message: 'Banner created successfully',
            remaining: MAX_BANNERS - (currentCount + 1),
            data: banner,
        };
    }

    private async checkLimit() {
        const count = await this.bannerModel
            .countDocuments({ isActive: true })
            .exec();

        if (count >= MAX_BANNERS) {
            throw new BadRequestException(
                `Banner limit reached. Maximum ${MAX_BANNERS} banners allowed.`,
            );
        }
    }
    // ─────────────────────────────────────────
    // GET ALL BANNERS (public)
    // ─────────────────────────────────────────

    async findAll() {
        const banners = await this.bannerModel
            .find({ isActive: true })
            .sort({ order: 1, createdAt: 1 })
            .exec();

        return {
            success: true,
            count: banners.length,
            remaining: MAX_BANNERS - banners.length,
            data: banners,
        };
    }

    // ─────────────────────────────────────────
    // UPLOAD BANNER (admin)
    // ─────────────────────────────────────────

    async uploadBanner(file: Express.Multer.File) {
        // 1. Check 4-banner limit
        const currentCount = await this.bannerModel
            .countDocuments({ isActive: true })
            .exec();

        if (currentCount >= MAX_BANNERS) {
            throw new BadRequestException(
                `Banner limit reached. Maximum ${MAX_BANNERS} banners allowed. Please delete an existing banner first.`,
            );
        }

        if (!file) {
            throw new BadRequestException('No image file provided');
        }

        // 2. Get Cloudinary URL from multer-storage-cloudinary
        const imageUrl = (file as any).path || '';
        const publicId = (file as any).filename || '';

        if (!imageUrl) {
            throw new BadRequestException('Image upload to Cloudinary failed');
        }

        // 3. Save banner to DB
        const order = currentCount; // next in sequence
        const banner = await this.bannerModel.create({
            imageUrl,
            publicId,
            order,
            isActive: true,
        });

        console.log(`✅ Banner uploaded: ${imageUrl}`);

        return {
            success: true,
            message: 'Banner uploaded successfully',
            remaining: MAX_BANNERS - (currentCount + 1),
            data: banner,
        };
    }

    // ─────────────────────────────────────────
    // DELETE BANNER (admin)
    // ─────────────────────────────────────────

    async deleteBanner(bannerId: string) {
        const banner = await this.bannerModel.findById(bannerId).exec();

        if (!banner) {
            throw new NotFoundException('Banner not found');
        }

        // Delete from Cloudinary
        if (banner.publicId) {
            try {
                await cloudinary.uploader.destroy(banner.publicId);
                console.log(`🗑️ Deleted from Cloudinary: ${banner.publicId}`);
            } catch (err) {
                console.warn('⚠️ Could not delete from Cloudinary:', err.message);
            }
        }

        // Delete from DB
        await this.bannerModel.deleteOne({ _id: bannerId }).exec();

        const remaining = await this.bannerModel
            .countDocuments({ isActive: true })
            .exec();

        return {
            success: true,
            message: 'Banner deleted successfully',
            remaining: MAX_BANNERS - remaining,
        };
    }

    // ─────────────────────────────────────────
    // GET BANNER COUNT (admin helper)
    // ─────────────────────────────────────────

    async getCount() {
        const count = await this.bannerModel
            .countDocuments({ isActive: true })
            .exec();

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
}