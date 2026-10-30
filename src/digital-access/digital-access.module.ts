import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { DigitalAccess, DigitalAccessSchema, DeliveryLog, DeliveryLogSchema } from './digital-access.schema';
import { DigitalAccessService } from './digital-access.service';
import { MembershipsModule } from '../memberships/memberships.module';
import { DigitalMailerModule } from './digital-mailer.module';
import { DigitalDeliveryService } from './digital-delivery.service';
import { DigitalBuyerController, DigitalSellerController } from './digital-access.controller';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    UploadModule,
    MembershipsModule,
    DigitalMailerModule,
    MongooseModule.forFeature([
      { name: DigitalAccess.name, schema: DigitalAccessSchema },
      { name: DeliveryLog.name, schema: DeliveryLogSchema },
    ]),
  ],
  controllers: [DigitalBuyerController, DigitalSellerController],
  providers: [DigitalAccessService, DigitalDeliveryService],
  exports: [DigitalAccessService, DigitalDeliveryService],
})
export class DigitalAccessModule {}
