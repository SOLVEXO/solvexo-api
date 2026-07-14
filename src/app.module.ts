import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
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
import { ActivityLogModule } from './activity-log/activity-log.module';
import { MarketingModule } from './marketing/marketing.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { PlatformSubscriptionsModule } from './platform-subscriptions/platform-subscriptions.module';
import { AdminAnalyticsModule } from './admin-analytics/admin-analytics.module';
import { AdminFinanceModule } from './admin-finance/admin-finance.module';
import { QueueModule } from './queues/queue.module';
import { HealthModule } from './health/health.module';
import { PlatformPlansModule } from './platform-plans/platform-plans.module';
import { SeoModule } from './seo/seo.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([
      // Platform-wide default: 100 req/min per IP. Endpoints that need a tighter
      // (payment/webhook) or looser (public browse) limit override via @Throttle().
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),
    DatabaseModule,
    QueueModule,
    HealthModule,
    ActivityLogModule,
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
    PlatformPlansModule,
    SchedulerModule,
    MarketingModule,
    LoyaltyModule,
    AnalyticsModule,
    PlatformSubscriptionsModule,
    AdminAnalyticsModule,
    AdminFinanceModule,
    SeoModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
