

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';

@Injectable()
export class CheckoutService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
  ) {}

  private round(n: number) { return Math.round(n * 100) / 100; }

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

    // Cache one lookup per store so a multi-item cart from the same store
    // doesn't re-query the buyer's subscription per item.
    const benefitsCache = new Map<string, { benefits: any[]; planName: string } | null>();
    const getBenefits = async (storeId: string) => {
      if (!benefitsCache.has(storeId)) {
        benefitsCache.set(storeId, await this.subscriptionBenefits.getActiveBenefits(userId, storeId));
      }
      return benefitsCache.get(storeId);
    };

    let subscriberSavingsUSD = 0;

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

      // Subscriber pricing is resolved server-side only — the client never
      // supplies a discount, it can only ever be computed from the buyer's
      // real active subscription to this product's store.
      const benefitsEntry = await getBenefits(product.storeId);
      const discount = benefitsEntry
        ? this.subscriptionBenefits.resolveProductDiscount(benefitsEntry.benefits, product as any, variant.price)
        : null;
      const unitPrice = discount?.subscriberPrice ?? variant.price;
      const lineDiscount = discount ? this.round(discount.savingsUSD * cartItem.quantity) : 0;
      subscriberSavingsUSD += lineDiscount;

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
        price: unitPrice,
        totalPrice: this.round(unitPrice * cartItem.quantity),
        originalPrice: discount ? variant.price : null,
        subscriberDiscountUSD: lineDiscount,
      });
    }

    let defaultAddressId: string | null = null;

    if (hasPhysical) {
      const defaultAddress = await addressModel.findOne({ userId, isDefault: true, isDelete: false });
      if (!defaultAddress) throw new BadRequestException('No default address found. Please set a default address first');
      defaultAddressId = defaultAddress._id.toString();
    }

    const subtotal = this.round(checkoutItems.reduce((sum, i) => sum + i.totalPrice, 0));
    const taxAmount = 0;
    const totalAmount = this.round(subtotal + taxAmount);

    // Checkout-time upsell: for any store in this cart the buyer is NOT
    // subscribed to, but which has an active plan offering a discount,
    // surface what they'd have saved — the highest-intent moment to convert.
    const subscriptionSavingsHints: Array<{ storeId: string; storeName: string; planId: string; planName: string; potentialSavingsUSD: number }> = [];
    const storeIdsInCart = [...new Set(checkoutItems.map((i) => i.storeId))];
    for (const sid of storeIdsInCart) {
      if (benefitsCache.get(sid)) continue; // already subscribed here
      const plan = await this.databaseService.repositories.subscriptionPlanModel
        .findOne({ storeId: sid, status: 'active', isDelete: false, 'benefits.type': 'discount' })
        .sort({ monthlyPriceUSD: 1 })
        .lean();
      if (!plan) continue;
      const storeItems = checkoutItems.filter((i) => i.storeId === sid);
      let potentialSavings = 0;
      for (const item of storeItems) {
        const d = this.subscriptionBenefits.resolveProductDiscount((plan as any).benefits, { _id: item.productId } as any, item.price);
        if (d) potentialSavings += this.round(d.savingsUSD * item.quantity);
      }
      if (potentialSavings > 0) {
        const store = await this.databaseService.repositories.storeModel.findById(sid).select('name').lean();
        subscriptionSavingsHints.push({
          storeId: sid, storeName: (store as any)?.name ?? 'this store',
          planId: (plan as any)._id.toString(), planName: (plan as any).name,
          potentialSavingsUSD: this.round(potentialSavings),
        });
      }
    }

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
      subscriberSavingsUSD: this.round(subscriberSavingsUSD),
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
        summary: { subtotal, shippingFee: 0, taxAmount, totalAmount, subscriberSavingsUSD: this.round(subscriberSavingsUSD) },
        subscriptionSavingsHints,
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

    let shippingFee = shippingZone.shippingPrice || 0;

    // Free/discounted shipping benefit — only applied when every item in the
    // checkout belongs to a single store (the shipping fee itself is a flat,
    // whole-checkout amount, not per-seller, so a mixed-store cart can't
    // unambiguously attribute the waiver to one store's membership).
    const storeIdsInCheckout = [...new Set((checkout.items as any[]).map((i) => i.storeId))];
    if (storeIdsInCheckout.length === 1) {
      const benefitsEntry = await this.subscriptionBenefits.getActiveBenefits(userId, storeIdsInCheckout[0]);
      if (benefitsEntry) {
        const shippingBenefit = this.subscriptionBenefits.resolveShippingBenefit(benefitsEntry.benefits);
        if (shippingBenefit && (shippingBenefit.minOrderValueForShippingUSD == null || checkout.subtotal >= shippingBenefit.minOrderValueForShippingUSD)) {
          shippingFee = this.round(shippingFee * (1 - shippingBenefit.discountPercent / 100));
        }
      }
    }

    const totalAmount = this.round(checkout.subtotal + shippingFee);

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