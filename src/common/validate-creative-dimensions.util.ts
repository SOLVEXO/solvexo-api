/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import type { PromotionPlacement } from './promotion-placements.const';

const MAX_CREATIVE_SIZE_BYTES = 5 * 1024 * 1024; // matches the existing banner-module convention (not the generic 100MB upload cap)
const MAX_VIDEO_CREATIVE_SIZE_BYTES = 50 * 1024 * 1024; // Video Banners — a real clip never fits the 5MB image cap

/**
 * Shared creative validation for promotional uploads (StoreBanner + PromotionRequest).
 * One implementation reused by both modules rather than duplicated checks.
 * Only enforces file size — an earlier aspect-ratio check hard-rejected
 * uploads that weren't a pixel-perfect 16:9/9:16 crop, which blocked routine
 * seller uploads for no real benefit, so it was removed.
 * A video file (Store Banners' "Video" type) gets its own, larger cap —
 * detected off the upload's own mimetype rather than `_variant`, since
 * `_variant` only ever describes an image placement today.
 */
export function validateCreativeDimensions(file: Express.Multer.File, _variant: PromotionPlacement | 'storeHero' | 'mobile'): void {
  const isVideo = file.mimetype.startsWith('video/');
  const max = isVideo ? MAX_VIDEO_CREATIVE_SIZE_BYTES : MAX_CREATIVE_SIZE_BYTES;
  if (file.size > max) {
    throw new BadRequestException(
      `Creative exceeds the ${max / (1024 * 1024)}MB limit for promotional ${isVideo ? 'videos' : 'images'}.`,
    );
  }
}
