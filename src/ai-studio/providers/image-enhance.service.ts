/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ImageEnhanceAdapter, ImageEnhanceRequest, ImageEnhanceResult,
} from './ai-provider.interfaces';

/**
 * STUB ONLY for this pass — image enhancement needs a dedicated
 * restoration/upscale model (e.g. Replicate-hosted Real-ESRGAN/GFPGAN, or a
 * commercial upscale API). Claude's API has no image generation/editing
 * capability — only image understanding — so no Claude implementation exists
 * or will exist for this adapter.
 *
 * The stub returns the original image untouched after a short delay so the
 * full async pipeline around it (credits hold/capture, job polling, history)
 * is exercised end-to-end today.
 *
 * TODO: integrate image enhancement provider — implement ImageEnhanceAdapter
 * (e.g. ReplicateImageEnhanceProvider), add its API key to env, and register
 * it in ImageEnhanceService's constructor switch below. Nothing else changes.
 */
class StubImageEnhanceProvider implements ImageEnhanceAdapter {
  readonly name = 'stub';

  async enhance(request: ImageEnhanceRequest): Promise<ImageEnhanceResult> {
    // Simulate provider latency so the jobId + polling flow behaves realistically.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      enhancedImageUrl: request.imageUrl,
      originalImageUrl: request.imageUrl,
      provider: this.name,
      note: `Stub provider — no real ${request.enhancementType} was applied. Wire a real image-enhancement provider to replace this.`,
    };
  }
}

/**
 * Env-selected provider wrapper, same pattern as TextGenerationService /
 * PaymentGatewayService. AI_IMAGE_PROVIDER currently supports only 'stub'.
 */
@Injectable()
export class ImageEnhanceService implements ImageEnhanceAdapter, OnModuleInit {
  private readonly logger = new Logger(ImageEnhanceService.name);
  private readonly provider: ImageEnhanceAdapter;
  readonly providerName: string;

  constructor(config: ConfigService) {
    this.providerName = config.get<string>('AI_IMAGE_PROVIDER') ?? 'stub';
    // TODO: integrate image enhancement provider — add real providers here:
    // if (this.providerName === 'replicate') this.provider = new ReplicateImageEnhanceProvider(...);
    this.provider = new StubImageEnhanceProvider();
  }

  get name(): string {
    return this.provider.name;
  }

  onModuleInit() {
    if (this.provider.name === 'stub') {
      this.logger.warn('Image Enhancer is running the STUB provider — images pass through unmodified. See ai-studio/README.md to plug in a real provider.');
    }
  }

  enhance(request: ImageEnhanceRequest): Promise<ImageEnhanceResult> {
    return this.provider.enhance(request);
  }
}
