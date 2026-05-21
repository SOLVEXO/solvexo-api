/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
// import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { categoryModule } from './categories/categories.module';
import { ProductsModule } from './products/product.module';
// import { OrdersModule } from './orders/orders.module';
import { CartModule } from './cart/cart.module';
import { AddressModule } from './address/address.module';
import { OtpModule } from './otp/otp.module';
import { UploadModule } from './upload/upload.module';
import { BannersModule } from './banner/banner.module';
import { FaqModule } from './faqs/faq.module';
import { RefundRequestModule } from './refund-request/refund-request.module';
import { checkoutModule } from './checkout/checkout.modoule';
// import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    // ✅ Load .env globally
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    // UsersModule,
    AuthModule,
    categoryModule,
    ProductsModule,
    // OrdersModule,
    CartModule,
    AddressModule,
    OtpModule,
    UploadModule,
    BannersModule,
    FaqModule,
    RefundRequestModule,
    checkoutModule,
    // RedisModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
