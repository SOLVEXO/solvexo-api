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
import { OtpModule } from './otp/otp.module';
import { UploadModule } from './upload/upload.module';
import { BannersModule } from './banner/banner.module';
import { FaqModule } from './faqs/faq.module';
// import { RefundRequestModule } from './refund-request/refund-request.module';
import { checkoutModule } from './checkout/checkout.modoule';
import { OrdersModule } from './orders/orders.module';
import { PaymentProcessingModule } from './payment/payment.module';
import { StoreModule } from './store/store.module';
import { EmployeeModule } from './pos/employee/employee.module';
import { RegisterSessionModule } from './pos/register-session/register-session.module';
import { SalesModule } from './pos/sales/sales.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    categoryModule,
    ProductsModule,
    CartModule,
    AddressModule,
    OtpModule,
    UploadModule,
    BannersModule,
    FaqModule,
    // RefundRequestModule,
    checkoutModule,
    OrdersModule,
    PaymentProcessingModule,
    StoreModule,
    EmployeeModule,
    RegisterSessionModule,
    SalesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
