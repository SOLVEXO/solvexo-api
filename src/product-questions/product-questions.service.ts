/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ProductQuestion, ProductQuestionDocument, QUESTION_STATUSES } from './product-question.schema';
import { cleanAnswer, cleanQuestion } from './product-questions.util';

const MAX_PER_PRODUCT_PENDING = 30;

@Injectable()
export class ProductQuestionsService {
  constructor(
    @InjectModel(ProductQuestion.name) private readonly model: Model<ProductQuestionDocument>,
    private readonly db: DatabaseService,
  ) {}

  private fail(e: unknown): never { throw new BadRequestException(e instanceof Error ? e.message : 'Invalid request'); }

  /** Storefront: answered + published questions of one product. Emails are never returned. */
  async publicList(storeId: string, productId: string) {
    const rows = await this.model.find({ storeId, productId, status: 'published' }).sort({ answeredAt: -1 }).limit(50).lean();
    return { items: rows.map((r: any) => ({ id: String(r._id), askerName: r.askerName, question: r.question, answer: r.answer, answeredAt: r.answeredAt, askedAt: r.createdAt })) };
  }

  /** Storefront: a shopper asks. It waits for the seller to answer; nothing shows until then. */
  async ask(storeId: string, productId: string, body: any) {
    let clean; try { clean = cleanQuestion(body); } catch (e) { this.fail(e); }
    const product: any = await this.db.repositories.productModel.findOne({ _id: productId, storeId, isDelete: false }).select('_id').lean();
    if (!product) throw new NotFoundException('Product not found');
    const waiting = await this.model.countDocuments({ storeId, productId, status: 'pending' });
    if (waiting >= MAX_PER_PRODUCT_PENDING) throw new BadRequestException('This product has many unanswered questions right now. Please try again later.');
    await this.model.create({ storeId, productId, ...clean, status: 'pending' });
    return { ok: true, message: 'Thanks! Your question was sent. It will appear here once the seller answers.' };
  }

  /** Seller inbox. */
  async sellerList(storeId: string, q: any) {
    const status = QUESTION_STATUSES.includes(q?.status) ? q.status : undefined;
    const page = Math.max(1, Number(q?.page) || 1); const limit = Math.min(50, Math.max(1, Number(q?.limit) || 20));
    const filter: any = { storeId, ...(status ? { status } : {}) };
    const [rows, total, pending] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
      this.model.countDocuments({ storeId, status: 'pending' }),
    ]);
    const ids = [...new Set(rows.map((r: any) => r.productId))];
    const products: any[] = ids.length ? await this.db.repositories.productModel.find({ _id: { $in: ids } }).select('name slug').lean() : [];
    const byId = new Map(products.map(p => [String(p._id), p]));
    return {
      items: rows.map((r: any) => ({ id: String(r._id), productId: r.productId, productName: byId.get(String(r.productId))?.name ?? '', productSlug: byId.get(String(r.productId))?.slug ?? null, askerName: r.askerName, askerEmail: r.askerEmail, question: r.question, answer: r.answer, answeredAt: r.answeredAt, status: r.status, askedAt: r.createdAt })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, pending,
    };
  }

  /** Answer a question (publishes it) or edit the answer. */
  async answer(storeId: string, id: string, body: any) {
    let answer: string; try { answer = cleanAnswer(body?.answer); } catch (e) { this.fail(e); }
    const doc = await this.model.findOneAndUpdate({ _id: id, storeId }, { $set: { answer, answeredAt: new Date(), status: body?.publish === false ? 'hidden' : 'published' } }, { new: true }).lean();
    if (!doc) throw new NotFoundException('Question not found');
    return { ok: true };
  }

  async setStatus(storeId: string, id: string, status: unknown) {
    if (!QUESTION_STATUSES.includes(status as any)) throw new BadRequestException('Status must be pending, published or hidden');
    const cur: any = await this.model.findOne({ _id: id, storeId }).lean();
    if (!cur) throw new NotFoundException('Question not found');
    if (status === 'published' && !cur.answer) throw new BadRequestException('Write an answer before publishing');
    await this.model.updateOne({ _id: id, storeId }, { $set: { status } });
    return { ok: true };
  }

  async remove(storeId: string, id: string) {
    const r = await this.model.deleteOne({ _id: id, storeId });
    if (!r.deletedCount) throw new NotFoundException('Question not found');
    return { ok: true };
  }
}
