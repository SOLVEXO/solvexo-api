import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { PublicSavedSectionsController } from '../storefront/public-saved-sections.controller';
import { SavedSection, SavedSectionSchema } from './saved-section.schema';
import { SavedSectionsController } from './saved-sections.controller';
import { SavedSectionsService } from './saved-sections.service';

@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: SavedSection.name, schema: SavedSectionSchema }])],
  controllers: [SavedSectionsController, PublicSavedSectionsController],
  providers: [SavedSectionsService],
})
export class SavedSectionsModule {}
