/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import * as streamifier from 'streamifier';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

@Injectable()
export class UploadService {
  constructor(private readonly configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  // ── PUBLIC upload ──
  async uploadFile(file: Express.Multer.File): Promise<{ url: string; publicId: string; resourceType: string }> {
    const resourceType = this.getResourceType(file.mimetype);
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: resourceType === 'raw' ? 'uploads/documents' : `uploads/${resourceType}s`,
          resource_type: resourceType as any,
          type: 'upload',
        },
        (error, result) => {
          if (error || !result) return reject(new BadRequestException(error?.message || 'Upload failed'));
          resolve({ url: result.secure_url, publicId: result.public_id, resourceType });
        },
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  // ── PRIVATE upload (digital products) ──
  async uploadPrivateFile(file: Express.Multer.File): Promise<{ publicId: string; resourceType: string; fileName: string; fileSize: number; mimeType: string }> {
    const resourceType = this.getResourceType(file.mimetype);
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'private/digital-products',
          resource_type: resourceType as any,
          type: 'private',
        },
        (error, result) => {
          if (error || !result) return reject(new BadRequestException(error?.message || 'Private upload failed'));
          resolve({
            publicId: result.public_id,
            resourceType,
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype,
          });
        },
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  // ── SIGNED URL generate ──
  generateSignedUrl(publicId: string, resourceType: string = 'raw', expirySeconds: number = 3600): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds;
    return cloudinary.url(publicId, {
      sign_url: true,
      type: 'private',
      resource_type: resourceType as any,
      expires_at: expiresAt,
    });
  }

  // ── PDF buffer download from Cloudinary (private) ──
  async downloadPrivatePdfBuffer(publicId: string): Promise<Buffer> {
    const signedUrl = this.generateSignedUrl(publicId, 'raw', 300); // 5 min — sirf download ke liye
    const response = await fetch(signedUrl);
    if (!response.ok) throw new BadRequestException('Failed to download PDF from storage');
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ── PDF Stamping ──
  async stampPdf(publicId: string, userEmail: string, orderNumber: string): Promise<Buffer> {
    const pdfBuffer = await this.downloadPrivatePdfBuffer(publicId);

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();

    const stampText = `Licensed to: ${userEmail} | Order: ${orderNumber}`;

    for (const page of pages) {
      const { width, height } = page.getSize();

      // bottom stamp
      page.drawText(stampText, {
        x: 20,
        y: 15,
        size: 8,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity: 0.6,
      });

      // diagonal watermark (center)
      page.drawText(userEmail, {
        x: width / 2 - 100,
        y: height / 2,
        size: 30,
        font,
        color: rgb(0.85, 0.85, 0.85),
        opacity: 0.15,
        rotate: { type: 'degrees' as any, angle: 45 },
      });
    }

    const stampedBytes = await pdfDoc.save();
    return Buffer.from(stampedBytes);
  }

  private getResourceType(mimetype: string): string {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    return 'raw';
  }
}
