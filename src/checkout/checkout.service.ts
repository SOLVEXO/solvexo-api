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

async addShippingInCheckout(
  userId: string,
  body: any,
) {
  const { checkoutId, shippingOptionId } = body;

  // 1. validations
  if (!checkoutId) {
    throw new BadRequestException('Checkout ID is required');
  }

  if (!shippingOptionId) {
    throw new BadRequestException('Shipping Option ID is required');
  }

  // 2. find checkout
  const checkout =
    await this.databaseService.repositories.checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });

  if (!checkout) {
    throw new NotFoundException('Checkout not found');
  }

  // 3. find shipping option
  const shippingOption =
    await this.databaseService.repositories.shippingZoneModel.findOne({
      _id: shippingOptionId,
      isDelete: false,
    });

  if (!shippingOption) {
    throw new NotFoundException('Shipping option not found');
  }

  // 4. get shipping amount
  const shippingAmount = shippingOption.shippingPrice || 0;


  // 5. calculate new total
  const totalAmount =
    checkout.subtotal +
    checkout.taxAmount +
    shippingAmount;

  // 6. update checkout
  checkout.shippingOptionId = shippingOptionId;
  checkout.shippingFee = shippingAmount;
  checkout.totalAmount = totalAmount;

  await checkout.save();

  // 7. return response
  return {
    success: true,
    message: 'Shipping added in checkout successfully',
    data: {
      checkout,
      summary: {
        subtotal: checkout.subtotal,
        taxAmount: checkout.taxAmount,
        shippingAmount,
        totalAmount,
      },
    },
  };
}

async changeCheckoutAddress(
  userId: string,
  body: any,
) {
  const { checkoutId, addressId } = body;

  // 1. validations
  if (!checkoutId) {
    throw new BadRequestException('Checkout ID is required');
  }

  if (!addressId) {
    throw new BadRequestException('Address ID is required');
  }

  // 2. find checkout
  const checkout =
    await this.databaseService.repositories.checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });

  if (!checkout) {
    throw new NotFoundException('Checkout not found');
  }

  // 3. update address
  checkout.addressId = addressId;

  await checkout.save();

  // 4. return response
  return {
    success: true,
    message: 'Checkout address changed successfully',
    data: checkout,
  };
}

async getCheckout(userId: string, checkoutId: string) {
  if (!checkoutId) {
    throw new BadRequestException('Checkout ID is required');
  }

  const checkout =
    await this.databaseService.repositories.checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });

  if (!checkout) {
    throw new NotFoundException('Checkout not found');
  }

  const enrichedItems: any[] = [];

  // 1. items loop
  for (const item of checkout.items) {
    const product =
      await this.databaseService.repositories.productModel.findOne({
        _id: item.productId,
        isDelete: false,
      });

    const variant =
      await this.databaseService.repositories.productVariantModel.findOne({
        _id: item.variantId,
        isDelete: false,
      });

    enrichedItems.push({
      product,
      variant,
      quantity: item.quantity,
      price: item.price,
      totalPrice: item.totalPrice,
    });
  }

  // 2. shipping
  let shippingOption = null;

  if (checkout.shippingOptionId) {
    shippingOption =
      await this.databaseService.repositories.shippingZoneModel.findOne({
        _id: checkout.shippingOptionId,
        isDelete: false,
      });
  }

  // 3. address
  let address = null;

  if (checkout.addressId) {
    address =
      await this.databaseService.repositories.addressModel.findOne({
        _id: checkout.addressId,
        isDelete: false,
      });
  }

  // 4. summary
  const subtotal = checkout.subtotal || 0;
  const taxAmount = checkout.taxAmount || 0;
  const shippingFee = checkout.shippingFee || 0;
  const totalAmount = subtotal + taxAmount + shippingFee;

  // 5. clean response (IMPORTANT PART)
  const cleanCheckout = {
    _id: checkout._id,
    userId: checkout.userId,
    addressId: checkout.addressId,
    shippingOptionId: checkout.shippingOptionId,
    paymentMethodId: checkout.paymentMethodId,
    status: checkout.status,
    expiredAt: checkout.expiredAt,

    items: enrichedItems,

    subtotal,
    taxAmount,
    shippingFee,
    totalAmount,
  };

  return {
    success: true,
    message: 'Checkout fetched successfully',
    data: {
      checkout: cleanCheckout,
      address,
      shippingOption,
      summary: {
        subtotal,
        taxAmount,
        shippingFee,
        totalAmount,
      },
    },
  };
}

}