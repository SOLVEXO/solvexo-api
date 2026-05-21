import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ConflictException,
    UnauthorizedException,

} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { DatabaseService } from 'src/database/databaseservice';


@Injectable()
export class checkoutService {
   constructor(private readonly databaseService: DatabaseService) {}

   // shipping-zone.service.ts

async addShippingZone(body: any) {

  try {

    const shippingZoneModel =
      this.databaseService.repositories.shippingZoneModel;

    const {
      country,
      province,
      city,
      shippingPrice,
      estimatedDeliveryTime,
      status
    } = body;

    // validation
    if (!country) {
      throw new BadRequestException('Country is required');
    }

    if (shippingPrice == null) {
      throw new BadRequestException(
        'Shipping price is required'
      );
    }

    // check existing shipping zone
    const existingShippingZone =
      await shippingZoneModel.findOne({
        country,
        province,
        city,
        isDelete: false
      });

    if (existingShippingZone) {
      throw new BadRequestException(
        'Shipping zone already exists'
      );
    }

    // create shipping zone
    const shippingZone =
      await shippingZoneModel.create({
        country,
        province,
        city,
        shippingPrice,
        estimatedDeliveryTime,
        status
      });

    return {
      message: 'Shipping zone added successfully',
      data: shippingZone
    };

  } catch (error) {

    throw error;

  }

}

// shipping-zone.service.ts

async getShippingZones() {

  try {

    const shippingZoneModel =
      this.databaseService.repositories.shippingZoneModel;

    // get all shipping zones
    const shippingZones =
      await shippingZoneModel.find({
        isDelete: false
      })
      .sort({ createdAt: -1 });

    return {
      message: 'Shipping zones fetched successfully',
      data: shippingZones
    };

  } catch (error) {

    throw error;

  }

}

async createCheckout(userId: string, body: any) {
  const { addressId, shippingOptionId } = body;

  if (!addressId) {
    throw new BadRequestException('Address ID is required');
  }


  const cart = await this.databaseService.repositories.cartModel.findOne({
    userId,
    status: 'active',
    isDelete: false,
  });

  if (!cart) {
    throw new BadRequestException('Cart not found');
  }

  if (!cart.items || cart.items.length === 0) {
    throw new BadRequestException('Cart is empty');
  }


    const checkoutItems = [] as any[];

  for (const item of cart.items) {
    const product = await this.databaseService.repositories.productModel.findOne({
      _id: item.productId,
      isDelete: false,
    });

    if (!product) {
      throw new NotFoundException(`Product not found: ${item.productId}`);
    }

    if (!product.sellerId) {
      throw new BadRequestException(
        `Seller ID not found for product: ${item.productId}`,
      );
    }

    const totalPrice = item.price * item.quantity;

    checkoutItems.push({
      productId: item.productId,
      variantId: item.productVariantId,
      sellerId: product.sellerId,
      quantity: item.quantity,
      price: item.price,
      totalPrice,
    });
  }

  const subtotal = checkoutItems.reduce((sum, item) => {
    return sum + item.totalPrice;
  }, 0);




  const taxAmount = 0;
  const totalAmount = subtotal  + taxAmount;

  const checkout = await this.databaseService.repositories.checkoutModel.create({
    userId,
    addressId,
    shippingOptionId,
    paymentMethodId: null,
    items: checkoutItems,
    subtotal,
    taxAmount,
    totalAmount,
    status: 'pending',
    expiredAt: new Date(Date.now() + 30 * 60 * 1000),
    isDelete: false,
  });

  return {
    success: true,
    message: 'Checkout created successfully',
    data: {
      checkout,
      summary: {
        subtotal,
        taxAmount,
        totalAmount,
      },
    },
  };
}

}