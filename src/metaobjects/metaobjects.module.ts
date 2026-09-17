/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { MetaobjectsController } from './metaobjects.controller';
import { PublicMetaobjectsController } from './public-metaobjects.controller';
import { MetaobjectsService } from './metaobjects.service';

// `RedisModule` alongside `AuthModule` — required by every module whose
// controller uses `JwtAuthGuard`, same reasoning as `MetafieldsModule`'s own
// doc comment.
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [MetaobjectsController, PublicMetaobjectsController],
  providers: [MetaobjectsService],
  exports: [MetaobjectsService],
})
export class MetaobjectsModule {}
