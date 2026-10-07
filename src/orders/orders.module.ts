// import { Module } from '@nestjs/common';
// import { OrdersController } from './orders.controller';
// import { OrdersService } from './orders.service';

// @Module({
//   controllers: [OrdersController],
//   providers: [OrdersService],
// })
// export class OrdersModule {}

import { Module } from '@nestjs/common';
import { OrderEditingService } from './order-editing.service';
import { OrderExchangeService } from './order-exchange.service';
import { OrderReturnsService } from './order-returns.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AuthModule } from '@/auth/auth.module';
import { UploadModule } from '@/upload/upload.module';
import { RedisModule } from '@/redis/redis.module';
import { FinanceModule } from '@/finance/finance.module';
import { PaymentModule } from '@/payment/payment.module';
import { ExchangeRateModule } from '@/exchange-rate/exchange-rate.module';
import { IntegrationsModule } from '@/integrations/integrations.module';
import { GiftCardsModule } from '@/gift-cards/gift-cards.module';
import { ShippingZonesModule } from '@/shipping-zones/shipping-zones.module';
import { InventoryModule } from '@/inventory/inventory.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    AuthModule,
    UploadModule,
    RedisModule,
    FinanceModule,
    PaymentModule,
    ExchangeRateModule,
    IntegrationsModule,
    GiftCardsModule,
    ShippingZonesModule,
    InventoryModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrderEditingService, OrderExchangeService, OrderReturnsService],
  exports: [OrdersService, OrderEditingService, OrderExchangeService, OrderReturnsService],
})
export class OrdersModule {}
