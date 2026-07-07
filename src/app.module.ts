import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { categoryModule } from './categories/categories.module';
import { ProductsModule } from './products/product.module';
import { CartModule } from './cart/cart.module';
import { AddressModule } from './address/address.module';
import { UsersModule } from './users/users.module';
import { OtpModule } from './otp/otp.module';
import { UploadModule } from './upload/upload.module';
import { BannersModule } from './banner/banner.module';
import { FaqModule } from './faqs/faq.module';
// import { RefundRequestModule } from './refund-request/refund-request.module';
import { CheckoutModule } from './checkout/checkout.modoule';
import { OrdersModule } from './orders/orders.module';
import { PaymentModule } from './payment/payment.module';
import { StoreModule } from './store/store.module';
import { InventoryModule } from './inventory/inventory.module';
import { RatingModule } from './rating/rating.module';
import { PosModule } from './pos/pos.module';
import { MessagingModule } from './messaging/messaging.module';
import { FinanceModule } from './finance/finance.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    categoryModule,
    ProductsModule,
    CartModule,
    AddressModule,
    UsersModule,
    OtpModule,
    UploadModule,
    BannersModule,
    FaqModule,
    // RefundRequestModule,
    CheckoutModule,
    // checkoutModule,
    OrdersModule,
    // OrdersModule,
    PaymentModule,
    // PaymentProcessingModule,
    StoreModule,
    InventoryModule,
    RatingModule,
    PosModule,
    MessagingModule,
    FinanceModule,
    SubscriptionsModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
