import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ContentVersioningModule } from '../common/content-versioning/content-versioning.module';
import { AppsModule } from '../apps/apps.module';
import { MetafieldsModule } from '../metafields/metafields.module';
import { CollectionTemplateController } from './collection-template.controller';
import { PublicCollectionTemplateController } from './public-collection-template.controller';
import { CollectionTemplateService } from './collection-template.service';

@Module({
  imports: [AuthModule, RedisModule, ContentVersioningModule, AppsModule, MetafieldsModule],
  controllers: [
    CollectionTemplateController,
    PublicCollectionTemplateController,
  ],
  providers: [CollectionTemplateService],
  exports: [CollectionTemplateService],
})
export class CollectionTemplateModule {}
