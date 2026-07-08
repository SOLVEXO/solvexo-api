

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class CheckoutService {
  constructor(private readonly databaseService: DatabaseService) {}

  async deleteCheckout(userId: string, checkoutId: string) {
    const { checkoutModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
    if (!checkout) throw new BadRequestException('Checkout not found');

    if (checkout.paymentType !== null) throw new BadRequestException('Cannot delete checkout after payment attempt');

    await checkoutModel.deleteOne({ _id: checkoutId });

    return { success: true, message: 'Checkout deleted successfully' };
  }

  async createCheckout(userId: string, body: any = {}) {
    const {
      cartModel, productModel, productVariantModel,
      addressModel, checkoutModel,
    } = this.databaseService.repositories;

    const cart = await cartModel.findOne({ userId, status: 'active', isDelete: false });
    if (!cart) throw new BadRequestException('Cart not found');
    if (!cart.items || cart.items.length === 0) throw new BadRequestException('Cart is empty');

    // agar items array diya to sirf woh, warna sab cart items
    const selectedItems: any[] = body.items && Array.isArray(body.items) && body.items.length > 0
      ? cart.items.filter((cartItem: any) =>
          body.items.some((sel: any) =>
            sel.productId === cartItem.productId &&
            sel.variantId === cartItem.productVariantId,
          ),
        )
      : cart.items;

    if (selectedItems.length === 0) throw new BadRequestException('None of the provided items found in cart');

    const checkoutItems: any[] = [];
    let hasPhysical = false;

    for (const cartItem of selectedItems) {
      const product = await productModel.findOne({ _id: cartItem.productId, status: 'active', isDelete: false });
      if (!product) throw new BadRequestException(`Product not found: ${cartItem.productId}`);

      const variant = await productVariantModel.findOne({ _id: cartItem.productVariantId, status: 'active', isDelete: false });
      if (!variant) throw new BadRequestException(`Variant not found: ${cartItem.productVariantId}`);

      if (product.type === 'physical') {
        hasPhysical = true;
        if (variant.stock < cartItem.quantity) {
          throw new BadRequestException(`Insufficient stock for: ${product.name}`);
        }
      }

      checkoutItems.push({
        productId: product._id.toString(),
        variantId: variant._id.toString(),
        sellerId: product.sellerId,
        storeId: product.storeId,
        type: product.type,
        name: product.name,
        image: product.images?.[0] ?? null,
        sku: variant.sku ?? null,
        size: variant.size ?? null,
        color: variant.color ?? null,
        licenseType: product.digital?.licenseType ?? null,
        quantity: cartItem.quantity,
        price: variant.price,
        totalPrice: variant.price * cartItem.quantity,
      });
    }

    let defaultAddressId: string | null = null;

    if (hasPhysical) {
      const defaultAddress = await addressModel.findOne({ userId, isDefault: true, isDelete: false });
      if (!defaultAddress) throw new BadRequestException('No default address found. Please set a default address first');
      defaultAddressId = defaultAddress._id.toString();
    }

    const subtotal = checkoutItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const taxAmount = 0;
    const totalAmount = subtotal + taxAmount;

    // Client-reported attribution — a mobile app has no meaningful
    // Referer/UTM headers, so this can only ever be as good as what the app
    // itself reports (e.g. "opened via a shared product link"). Unknown or
    // invalid values fall back to 'other' rather than being rejected.
    const validAttributionSources = ['marketplace_search', 'direct_link', 'social_media', 'email', 'other'];
    const attributionSource = validAttributionSources.includes(body.attributionSource)
      ? body.attributionSource
      : 'other';

    const checkout = await checkoutModel.create({
      userId,
      addressId: defaultAddressId,
      currency: 'USD',
      items: checkoutItems,
      shippingZoneId: null,
      paymentType: null,
      paymentMethodId: null,
      subtotal,
      shippingFee: 0,
      taxAmount,
      totalAmount,
      status: 'pending',
      attributionSource,
      expiredAt: new Date(Date.now() + 30 * 60 * 1000),
      isDelete: false,
    });

    const hasDigital = checkoutItems.some((i) => i.type === 'digital');

    return {
      success: true,
      message: 'Checkout created successfully',
      data: {
        checkout,
        allowedPaymentMethods: hasDigital ? ['stripe'] : ['stripe', 'cash_on_delivery'],
        summary: { subtotal, shippingFee: 0, taxAmount, totalAmount },
      },
    };
  }

  async addShippingInCheckout(userId: string, body: any) {
    const { checkoutId, shippingZoneId } = body;

    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!shippingZoneId) throw new BadRequestException('shippingZoneId is required');

    const { checkoutModel, shippingZoneModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'completed') throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'expired') throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'expired' });
      throw new BadRequestException('Checkout has expired');
    }

    const shippingZone = await shippingZoneModel.findOne({ _id: shippingZoneId, isDelete: false });
    if (!shippingZone) throw new NotFoundException('Shipping zone not found');

    const shippingFee = shippingZone.shippingPrice || 0;
    const totalAmount = checkout.subtotal + shippingFee;

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      shippingZoneId,
      shippingFee,
      totalAmount,
    });

    return {
      success: true,
      message: 'Shipping added to checkout',
      data: {
        checkoutId,
        shippingZoneId,
        shippingFee,
        subtotal: checkout.subtotal,
        totalAmount,
      },
    };
  }

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
}