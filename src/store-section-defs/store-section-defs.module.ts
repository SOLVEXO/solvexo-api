import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SavedSection, SavedSectionSchema } from '../saved-sections/saved-section.schema';
import { PublicStoreSectionDefsController } from '../storefront/public-store-section-defs.controller';
import { StoreSectionDef, StoreSectionDefSchema } from './store-section-def.schema';
import { StoreSectionDefsController } from './store-section-defs.controller';
import { StoreSectionDefsService } from './store-section-defs.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: StoreSectionDef.name, schema: StoreSectionDefSchema },
      { name: SavedSection.name, schema: SavedSectionSchema },
    ]),
  ],
  controllers: [StoreSectionDefsController, PublicStoreSectionDefsController],
  providers: [StoreSectionDefsService],
})
export class StoreSectionDefsModule {}
