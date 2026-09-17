import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { ContentVersioningModule } from '../common/content-versioning/content-versioning.module';
import { StorePagesController } from './store-pages.controller';
import { PublicStorePagesController } from './public-store-pages.controller';
import { StorePagesService } from './store-pages.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    AdminConfigModule,
    ContentVersioningModule,
  ],
  controllers: [StorePagesController, PublicStorePagesController],
  providers: [StorePagesService],
  exports: [StorePagesService],
})
export class StorePagesModule {}
