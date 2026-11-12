import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SearchConfig, SearchConfigSchema, SearchMiss, SearchMissSchema } from './search-discovery.schema';
import { PublicSearchConfigController, SearchDiscoveryController } from './search-discovery.controller';
import { SearchDiscoveryService } from './search-discovery.service';

@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: SearchConfig.name, schema: SearchConfigSchema }, { name: SearchMiss.name, schema: SearchMissSchema }])],
  controllers: [SearchDiscoveryController, PublicSearchConfigController],
  providers: [SearchDiscoveryService],
  exports: [SearchDiscoveryService],
})
export class SearchDiscoveryModule {}
