/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class MediaLibraryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
  ) {}

  private get model() {
    return this.databaseService.repositories.mediaAssetModel;
  }

  /** Uploads via the shared UploadService, then tracks the result for later reuse (the "choose existing" picker). */
  async uploadAndTrack(
    file: Express.Multer.File,
    ownerType: 'admin' | 'seller',
    ownerId: string,
    options?: { folder?: string; maxDimension?: number },
  ) {
    const uploaded = await this.uploadService.uploadFile(file, options);
    const asset = await this.model.create({
      ownerType,
      ownerId,
      url: uploaded.url,
      publicId: uploaded.publicId,
      resourceType: uploaded.resourceType,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
    });
    return { ...uploaded, mediaAssetId: asset._id };
  }

  async listForOwner(ownerType: 'admin' | 'seller', ownerId: string, limit = 60) {
    return this.model.find({ ownerType, ownerId }).sort({ createdAt: -1 }).limit(limit).lean();
  }
}
