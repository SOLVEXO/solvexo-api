import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as schema from './schema';
import { DatabaseService } from './databaseservice'

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,   
    }),

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGO_URI'),
      }),
    }),

    MongooseModule.forFeature([
      { name: schema.User.name, schema: schema.UserSchema },
      { name: schema.Seller.name, schema: schema.SellerSchema },
      { name: schema.Admin.name, schema: schema.AdminSchema },
      {name: schema.Category.name, schema: schema.CategorySchema },
      {name: schema.Product.name, schema: schema.ProductSchema},
       {name: schema.ProductVariant.name, schema: schema.ProductVariantSchema},
       {name: schema.Cart.name, schema: schema.CartSchema},
        {name: schema.wishList.name, schema: schema.wishListSchema},
        {name: schema.Rating.name, schema: schema.RatingSchema},
        {name: schema.Address.name, schema: schema.AddressSchema},
        {name: schema.UserPaymentMethod.name, schema: schema.UserPaymentMethodSchema},
        {name: schema.ShippingZone.name, schema: schema.ShippingZoneSchema},
        {name: schema.Checkout.name, schema: schema.CheckoutSchema},
        { name: schema.Order.name, schema: schema.OrderSchema },
      { name: schema.PaymentTransaction.name, schema: schema.PaymentTransactionSchema },
      { name: schema.Store.name, schema: schema.StoreSchema },
    ]),
  ],
  exports: [MongooseModule, DatabaseService],
  providers: [DatabaseService],
})
export class DatabaseModule {}