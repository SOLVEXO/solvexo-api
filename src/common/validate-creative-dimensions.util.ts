/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import type { PromotionPlacement } from './promotion-placements.const';

const MAX_CREATIVE_SIZE_BYTES = 5 * 1024 * 1024; // matches the existing banner-module convention (not the generic 100MB upload cap)

/**
 * Shared creative validation for promotional uploads (StoreBanner + PromotionRequest).
 * One implementation reused by both modules rather than duplicated checks.
 * Only enforces file size — an earlier aspect-ratio check hard-rejected
 * uploads that weren't a pixel-perfect 16:9/9:16 crop, which blocked routine
 * seller uploads for no real benefit, so it was removed.
 */
export function validateCreativeDimensions(file: Express.Multer.File, _variant: PromotionPlacement | 'storeHero' | 'mobile'): void {
  if (file.size > MAX_CREATIVE_SIZE_BYTES) {
    throw new BadRequestException(
      `Creative exceeds the ${MAX_CREATIVE_SIZE_BYTES / (1024 * 1024)}MB limit for promotional images.`,
    );
  }
}
