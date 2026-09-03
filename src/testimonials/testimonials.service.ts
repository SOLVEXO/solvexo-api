import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { PlatformTestimonial, PlatformTestimonialDocument } from './schemas/platform-testimonial.schema';
import { CreateTestimonialDto, UpdateTestimonialDto, SubmitTestimonialDto } from './dto/testimonial.dto';

@Injectable()
export class TestimonialsService {
  constructor(
    @InjectModel(PlatformTestimonial.name)
    private testimonialModel: Model<PlatformTestimonialDocument>,
    private readonly databaseService: DatabaseService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  // ─── PUBLIC — homepage social-proof section ─────────────────────────────
  async findAllActive(limit: number) {
    const testimonials = await this.testimonialModel
      .find({ isActive: true })
      .sort({ order: 1, createdAt: -1 })
      .limit(limit)
      .lean();

    return {
      success: true,
      count: testimonials.length,
      data: testimonials.map((t: any) => ({
        id: t._id.toString(),
        name: t.sellerName,
        storeName: t.storeName ?? null,
        rating: t.rating,
        text: t.text,
        isVerifiedSeller: t.isVerifiedSeller,
      })),
    };
  }

  // ─── ADMIN ───────────────────────────────────────────────────────────────
  async findAll() {
    const testimonials = await this.testimonialModel.find().sort({ order: 1, createdAt: -1 }).exec();
    const active = testimonials.filter((t) => t.isActive).length;
    const inactive = testimonials.length - active;

    return { success: true, count: testimonials.length, stats: { active, inactive }, data: testimonials };
  }

  async create(dto: CreateTestimonialDto) {
    const testimonial = await this.testimonialModel.create(dto);
    return { success: true, message: 'Testimonial created successfully', data: testimonial };
  }

  async update(id: string, dto: UpdateTestimonialDto) {
    const testimonial = await this.testimonialModel.findByIdAndUpdate(id, dto, { new: true }).exec();
    if (!testimonial) throw new NotFoundException('Testimonial not found');
    return { success: true, message: 'Testimonial updated successfully', data: testimonial };
  }

  async toggleActive(id: string) {
    const testimonial = await this.testimonialModel.findById(id).exec();
    if (!testimonial) throw new NotFoundException('Testimonial not found');

    testimonial.isActive = !testimonial.isActive;
    await testimonial.save();

    return { success: true, message: `Testimonial ${testimonial.isActive ? 'activated' : 'deactivated'}`, data: testimonial };
  }

  async remove(id: string) {
    const testimonial = await this.testimonialModel.findByIdAndDelete(id).exec();
    if (!testimonial) throw new NotFoundException('Testimonial not found');
    return { success: true, message: 'Testimonial deleted successfully' };
  }

  // ─── SELLER SELF-SUBMISSION ──────────────────────────────────────────────

  /** The seller's own latest submission (any status) — lets the dashboard
   *  show "already submitted, pending review" instead of the form again. */
  async getMySubmission(sellerId: string) {
    const testimonial = await this.testimonialModel
      .findOne({ sellerId, submittedBy: 'seller' })
      .sort({ createdAt: -1 })
      .lean();
    return { success: true, data: testimonial ?? null };
  }

  /** `sellerName`/`storeName` are never taken from the request body — always
   *  looked up from the authenticated seller's own real account, so a seller
   *  can never submit a quote attributed to a different name/store. */
  async submitAsSeller(sellerId: string, dto: SubmitTestimonialDto) {
    const existing = await this.testimonialModel.findOne({ sellerId, submittedBy: 'seller' }).lean();
    if (existing && existing.status !== 'rejected') {
      throw new BadRequestException('You have already submitted a story — you can only have one at a time.');
    }

    const seller = await this.repos.sellerModel.findById(sellerId).select('name');
    if (!seller) throw new ForbiddenException('Seller not found');
    const store = await this.repos.storeModel
      .findOne({ sellerId, status: 'active' })
      .sort({ createdAt: 1 })
      .select('name');

    const testimonial = await this.testimonialModel.create({
      sellerName: seller.name,
      storeName: store?.name ?? null,
      sellerId,
      storeId: store ? String((store as any)._id) : null,
      status: 'pending',
      submittedBy: 'seller',
      isVerifiedSeller: true,
      isActive: false,
      rating: dto.rating,
      text: dto.text,
    });

    return { success: true, message: 'Thanks — your story is submitted for review.', data: testimonial };
  }

  // ─── ADMIN MODERATION (seller-submitted only) ────────────────────────────

  async approve(id: string) {
    const testimonial = await this.testimonialModel.findByIdAndUpdate(
      id,
      { status: 'approved', isActive: true },
      { new: true },
    );
    if (!testimonial) throw new NotFoundException('Testimonial not found');
    return { success: true, message: 'Testimonial approved and published', data: testimonial };
  }

  async reject(id: string) {
    const testimonial = await this.testimonialModel.findByIdAndUpdate(
      id,
      { status: 'rejected', isActive: false },
      { new: true },
    );
    if (!testimonial) throw new NotFoundException('Testimonial not found');
    return { success: true, message: 'Testimonial rejected', data: testimonial };
  }
}
