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
import { B2BContextService } from './b2b-context.service';
import { B2BOrdersService } from './b2b-orders.service';
import { B2BOrdersController } from './b2b-orders.controller';
import { B2BRemindersService } from './b2b-reminders.service';
import { B2BStorefrontController } from './b2b-storefront.controller';

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
  controllers: [B2BAdminController, B2BOrdersController, B2BStorefrontController],
  providers: [B2BAdminService, B2BContextService, B2BOrdersService, B2BRemindersService],
  exports: [B2BAdminService, B2BContextService, MongooseModule],
})
export class B2BModule {}
