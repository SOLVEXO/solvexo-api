import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { UploadService } from '../upload/upload.service';
import { Store } from '../store/schemas/store.schema';
import { CreateDocumentFileDto, ListDocumentFilesDto, UpdateDocumentFileDto } from './dto/store-document.dto';
import { DocumentFile, STORE_DOCUMENT_CATEGORIES } from './schemas/store-document.schema';

/** Cloudinary's PDF → image conversion (`pg_1` = first page). Works only for `image` deliveries. */
const CLOUD_NAME = () => process.env.CLOUDINARY_CLOUD_NAME || '';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(DocumentFile.name) private readonly model: Model<DocumentFile>,
    @InjectModel(Store.name) private readonly storeModel: Model<Store>,
    private readonly uploadService: UploadService,
    private readonly config: ConfigService,
  ) {}

  private folder(storeId: string) {
    return `documents/${storeId}`;
  }

  /** A public id is only accepted when it was uploaded into THIS store's documents folder. */
  private assertOwnPublicId(storeId: string, publicId: string) {
    const prefix = `${this.folder(storeId)}/`;
    if (!publicId.startsWith(prefix) || publicId.includes('..')) {
      throw new BadRequestException('The file must be uploaded to this store first.');
    }
  }

  private async owned(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
  }

  private async findOwned(storeId: string, sellerId: string, id: string) {
    await this.owned(storeId, sellerId);
    const doc = await this.model.findOne({ _id: id, storeId, isDelete: false });
    if (!doc) throw new NotFoundException('Document not found.');
    return doc;
  }

  /** Step 1 of the seller flow: the browser uploads the PDF here, then creates the record. */
  async uploadFile(storeId: string, sellerId: string, file?: Express.Multer.File) {
    await this.owned(storeId, sellerId);
    if (!file) throw new BadRequestException('No file uploaded.');
    const isPdf = /\.pdf$/i.test(file.originalname || '') || file.mimetype === 'application/pdf';
    if (!isPdf) throw new BadRequestException('Only PDF files can be added here.');
    if (file.size > MAX_FILE_BYTES) throw new BadRequestException('The PDF is larger than 50 MB.');
    const uploaded = await this.uploadService.uploadFile(file, { folder: this.folder(storeId) });
    return {
      publicId: uploaded.publicId,
      fileUrl: uploaded.url,
      resourceType: uploaded.resourceType,
      sizeBytes: file.size,
    };
  }

  async listForSeller(storeId: string, sellerId: string, query: ListDocumentFilesDto) {
    await this.owned(storeId, sellerId);
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 50));
    const filter: any = { storeId, isDelete: false };
    if (query.category) filter.category = query.category;
    if (query.status) filter.status = query.status;
    if (query.search) filter.title = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  async create(storeId: string, sellerId: string, dto: CreateDocumentFileDto) {
    await this.owned(storeId, sellerId);
    if (dto.publicId) this.assertOwnPublicId(storeId, dto.publicId);
    const created = await this.model.create({
      storeId,
      title: dto.title.trim(),
      category: dto.category ?? 'catalogue',
      description: dto.description ?? '',
      publicId: dto.publicId,
      fileUrl: dto.fileUrl || this.cloudUrl(dto.publicId, 'raw'),
      resourceType: 'raw',
      coverUrl: dto.coverUrl || null,
      coverPublicId: dto.coverPublicId || null,
      sizeBytes: dto.sizeBytes ?? null,
      pages: dto.pages ?? null,
      language: dto.language ?? '',
      status: dto.active === false ? 'hidden' : 'active',
      createdBy: sellerId,
    });
    // The first page of the PDF becomes the cover, so the seller does not have to make one.
    void this.tryPdfCover(created);
    return created;
  }

  async update(storeId: string, sellerId: string, id: string, dto: UpdateDocumentFileDto) {
    const doc = await this.findOwned(storeId, sellerId, id);
    if (dto.publicId && dto.publicId !== doc.publicId) {
      this.assertOwnPublicId(storeId, dto.publicId);
      const old = doc.publicId;
      doc.publicId = dto.publicId;
      doc.fileUrl = dto.fileUrl || this.cloudUrl(dto.publicId, 'raw');
      doc.resourceType = 'raw';
      doc.sizeBytes = dto.sizeBytes ?? null;
      doc.pages = dto.pages ?? null;
      await this.removeFile(old, 'raw');
    }
    if (dto.title !== undefined) doc.title = dto.title.trim();
    if (dto.category !== undefined) doc.category = dto.category;
    if (dto.description !== undefined) doc.description = dto.description;
    if (dto.language !== undefined) doc.language = dto.language;
    if (dto.active !== undefined) doc.status = dto.active ? 'active' : 'hidden';
    doc.isDelete = false;
    await doc.save();
    if (!doc.coverUrl) void this.tryPdfCover(doc);
    return doc;
  }

  async remove(storeId: string, sellerId: string, id: string) {
    const doc = await this.findOwned(storeId, sellerId, id);
    doc.isDelete = true;
    doc.status = 'hidden';
    await doc.save();
    await this.removeFile(doc.publicId, doc.resourceType);
    if (doc.coverPublicId) await this.removeFile(doc.coverPublicId, 'image');
    return { ok: true };
  }

  /** The seller's own cover photo wins; the PDF's first page is only a fallback. */
  async setCover(storeId: string, sellerId: string, id: string, publicId?: string, url?: string) {
    const doc = await this.findOwned(storeId, sellerId, id);
    if (publicId) {
      const prefix = `${this.folder(storeId)}/`;
      if (!publicId.startsWith(prefix) || publicId.includes('..')) {
        throw new BadRequestException('The cover must be uploaded to this store first.');
      }
      if (doc.coverPublicId) await this.removeFile(doc.coverPublicId, 'image');
      doc.coverPublicId = publicId;
      doc.coverUrl = url || this.cloudUrl(publicId, 'image');
    } else {
      if (doc.coverPublicId) await this.removeFile(doc.coverPublicId, 'image');
      doc.coverPublicId = null;
      doc.coverUrl = null;
      await this.tryPdfCover(doc);
    }
    await doc.save();
    return doc;
  }

  /** Public storefront list — only active documents of a store. */
  async listPublic(storeId: string, category?: string) {
    const filter: any = { storeId, isDelete: false, status: 'active' };
    if (category && (STORE_DOCUMENT_CATEGORIES as readonly string[]).includes(category)) filter.category = category;
    const items = await this.model.find(filter).sort({ createdAt: -1 }).limit(200)
      .select('title category description fileUrl coverUrl sizeBytes pages language createdAt').lean();
    return { items };
  }

  /** Public: the PDF opens in the browser. */
  async view(id: string) {
    const doc = await this.model.findOneAndUpdate(
      { _id: id, isDelete: false, status: 'active' },
      { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } },
      { new: false },
    ).lean();
    if (!doc) throw new NotFoundException('Document not found.');
    return { url: doc.fileUrl, title: doc.title };
  }

  /** Public: a real download (Cloudinary `fl_attachment`, a clean file name). */
  async download(id: string) {
    const doc = await this.model.findOneAndUpdate(
      { _id: id, isDelete: false, status: 'active' },
      { $inc: { downloadCount: 1 }, $set: { lastViewedAt: new Date() } },
      { new: false },
    ).lean();
    if (!doc) throw new NotFoundException('Document not found.');
    return { url: this.downloadUrl(doc.publicId, doc.resourceType, doc.title), title: doc.title };
  }

  async stats(storeId: string) {
    const rows = await this.model.aggregate([
      { $match: { storeId, isDelete: false } },
      { $group: { _id: '$category', count: { $sum: 1 }, views: { $sum: '$viewCount' }, downloads: { $sum: '$downloadCount' } } },
    ]);
    return { rows };
  }

  private cloudUrl(publicId: string, resourceType: string) {
    const cloud = CLOUD_NAME();
    if (!cloud) return '';
    const ext = resourceType === 'raw' ? '.pdf' : '';
    return `https://res.cloudinary.com/${cloud}/${resourceType}/upload/${publicId}${ext}`;
  }

  private downloadUrl(publicId: string, resourceType: string, title: string) {
    const cloud = CLOUD_NAME();
    if (!cloud) return this.cloudUrl(publicId, resourceType);
    const name = (title || 'document').replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
    const ext = resourceType === 'raw' ? '.pdf' : '';
    return `https://res.cloudinary.com/${cloud}/${resourceType}/upload/fl_attachment/${publicId}${ext}`;
  }

  private async removeFile(publicId: string, resourceType: string) {
    if (!publicId) return;
    try {
      await this.uploadService.deleteFile(publicId, resourceType);
    } catch {
      /* best effort — a Cloudinary failure must not block the seller */
    }
  }

  /**
   * Cover from the PDF's own first page. Cloudinary converts only `image` deliveries, so when it
   * cannot (a `raw` upload, or the account lacks the add-on) the cover stays empty and the theme
   * shows a neutral icon — never a broken picture.
   */
  private async tryPdfCover(doc: any) {
    if (doc.coverUrl || !doc.publicId) return;
    const cloud = CLOUD_NAME();
    if (!cloud) return;
    const candidate = `https://res.cloudinary.com/${cloud}/image/upload/pg_1/${doc.publicId}.jpg`;
    try {
      const res = await fetch(candidate, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      if (!res.ok) return;
      doc.coverUrl = candidate;
      await doc.save();
    } catch {
      /* no cover — the seller can upload one */
    }
  }
}