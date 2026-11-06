import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import {
  B2BApplication, B2BApplicationSchema, B2BBuyer, B2BBuyerSchema, B2BCatalog, B2BCatalogItem, B2BCatalogItemSchema, B2BCatalogSchema,
  B2BCompany, B2BCompanySchema, B2BLocation, B2BLocationSchema,
} from './b2b.schema';
import { B2BAdminService } from './b2b-admin.service';
import { B2BAdminController } from './b2b-admin.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: B2BCompany.name, schema: B2BCompanySchema },
      { name: B2BLocation.name, schema: B2BLocationSchema },
      { name: B2BBuyer.name, schema: B2BBuyerSchema },
      { name: B2BApplication.name, schema: B2BApplicationSchema },
      { name: B2BCatalog.name, schema: B2BCatalogSchema },
      { name: B2BCatalogItem.name, schema: B2BCatalogItemSchema },
    ]),
  ],
  controllers: [B2BAdminController],
  providers: [B2BAdminService],
  exports: [B2BAdminService, MongooseModule],
})
export class B2BModule {}
