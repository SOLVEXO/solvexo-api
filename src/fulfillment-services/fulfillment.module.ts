import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { FulfillmentCallbackController, FulfillmentServicesController } from './fulfillment.controller';
import { FulfillmentProcessor } from './fulfillment.processor';
import { FulfillmentRequest, FulfillmentRequestSchema, FulfillmentService, FulfillmentServiceSchema } from './fulfillment.schema';
import { FulfillmentServicesService } from './fulfillment.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    MongooseModule.forFeature([
      { name: FulfillmentService.name, schema: FulfillmentServiceSchema },
      { name: FulfillmentRequest.name, schema: FulfillmentRequestSchema },
    ]),
  ],
  controllers: [FulfillmentServicesController, FulfillmentCallbackController],
  providers: [FulfillmentServicesService, FulfillmentProcessor],
  exports: [FulfillmentServicesService],
})
export class FulfillmentServicesModule {}
