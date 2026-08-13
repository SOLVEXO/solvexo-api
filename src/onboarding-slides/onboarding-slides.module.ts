import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { MediaLibraryModule } from '../media-library/media-library.module';
import { OnboardingSlidesController } from './onboarding-slides.controller';
import { OnboardingSlidesService } from './onboarding-slides.service';

@Module({
  imports: [AuthModule, RedisModule, MediaLibraryModule],
  controllers: [OnboardingSlidesController],
  providers: [OnboardingSlidesService],
  exports: [OnboardingSlidesService],
})
export class OnboardingSlidesModule {}
