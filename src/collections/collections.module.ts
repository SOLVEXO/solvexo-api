import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { PublicCollectionsController } from './public-collections.controller';
import { CollectionsService } from './collections.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [CollectionsController, PublicCollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
