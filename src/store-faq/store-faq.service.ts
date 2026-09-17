/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateStoreFaqDto, UpdateStoreFaqDto } from './dto/create-store-faq.dto';

@Injectable()
export class StoreFaqService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get storeFaqModel() {
    return this.databaseService.repositories.storeFaqModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  private async findOwnedFaq(storeId: string, sellerId: string, faqId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const faq = await this.storeFaqModel.findOne({ _id: faqId, storeId });
    if (!faq) throw new NotFoundException('FAQ not found');
    return faq;
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const faqs = await this.storeFaqModel.find({ storeId }).sort({ order: 1, createdAt: 1 }).lean();
    return { success: true, data: faqs };
  }

  async create(storeId: string, sellerId: string, dto: CreateStoreFaqDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const faq = await this.storeFaqModel.create({
      storeId,
      question: dto.question,
      answer: dto.answer,
      order: dto.order ?? 0,
      isActive: dto.isActive ?? true,
    });
    return { success: true, message: 'FAQ created', data: faq };
  }

  async update(storeId: string, sellerId: string, faqId: string, dto: UpdateStoreFaqDto) {
    await this.findOwnedFaq(storeId, sellerId, faqId);
    const set: Record<string, unknown> = {};
    if (dto.question !== undefined) set.question = dto.question;
    if (dto.answer !== undefined) set.answer = dto.answer;
    if (dto.order !== undefined) set.order = dto.order;
    if (dto.isActive !== undefined) set.isActive = dto.isActive;

    const updated = await this.storeFaqModel.findOneAndUpdate({ _id: faqId, storeId }, { $set: set }, { new: true });
    return { success: true, message: 'FAQ updated', data: updated };
  }

  async remove(storeId: string, sellerId: string, faqId: string) {
    await this.findOwnedFaq(storeId, sellerId, faqId);
    await this.storeFaqModel.deleteOne({ _id: faqId, storeId });
    return { success: true, message: 'FAQ deleted' };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async findActiveForStore(storeId: string) {
    const faqs = await this.storeFaqModel
      .find({ storeId, isActive: true })
      .sort({ order: 1, createdAt: 1 })
      .select('question answer order')
      .lean();
    return { success: true, count: faqs.length, data: faqs };
  }
}
