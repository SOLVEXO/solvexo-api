import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { StoreBlogController } from './store-blog.controller';
import { PublicStoreBlogController } from './public-store-blog.controller';
import { StoreBlogService } from './store-blog.service';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule],
  controllers: [StoreBlogController, PublicStoreBlogController],
  providers: [StoreBlogService],
  exports: [StoreBlogService],
})
export class StoreBlogModule {}
