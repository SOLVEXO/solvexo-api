import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { MarketingService } from 'src/marketing/marketing.service';
import { pickBestCampaign } from 'src/marketing/campaign-pricing.util';

@Injectable()
export class CheckoutService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
    private readonly marketingService: MarketingService,
  ) {}

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  /** Digital/physical subtotal split — used so the app can show "pay this
   *  much online now" vs "this much COD on delivery" for a mixed cart. Both
   *  numbers are read straight off `item.totalPrice`, which already has
   *  subscriber/campaign/coupon discounts baked in, so this stays correct
   *  after `applyCoupon`/`removeCoupon` mutate `items` in place. */
  private splitSubtotalsByType(items: any[]) {
    const digitalSubtotal = this.round(
      items.filter((i) => i.type === 'digital').reduce((s, i) => s + i.totalPrice, 0),
    );
    const physicalSubtotal = this.round(
      items.filter((i) => i.type === 'physical').reduce((s, i) => s + i.totalPrice, 0),
    );
    return { digitalSubtotal, physicalSubtotal };
  }

  async deleteCheckout(userId: string, checkoutId: string) {
    const { checkoutModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new BadRequestException('Checkout not found');

    if (checkout.paymentType !== null)
      throw new BadRequestException(
        'Cannot delete checkout after payment attempt',
      );

    await checkoutModel.deleteOne({ _id: checkoutId });

    return { success: true, message: 'Checkout deleted successfully' };
  }

  async createCheckout(userId: string, body: any = {}) {
    const {
      cartModel,
      productModel,
      productVariantModel,
      addressModel,
      checkoutModel,
    } = this.databaseService.repositories;

    const cart = await cartModel.findOne({
      userId,
      status: 'active',
      isDelete: false,
    });
    if (!cart) throw new BadRequestException('Cart not found');
    if (!cart.items || cart.items.length === 0)
      throw new BadRequestException('Cart is empty');

    // agar items array diya to sirf woh, warna sab cart items
    const selectedItems: any[] =
      body.items && Array.isArray(body.items) && body.items.length > 0
        ? cart.items.filter((cartItem: any) =>
            body.items.some(
              (sel: any) =>
                sel.productId === cartItem.productId &&
                sel.variantId === cartItem.productVariantId,
            ),
          )
        : cart.items;

    if (selectedItems.length === 0)
      throw new BadRequestException('None of the provided items found in cart');

    const checkoutItems: any[] = [];
    let hasPhysical = false;

    // Cache one lookup per store so a multi-item cart from the same store
    // doesn't re-query the buyer's subscription per item.
    const benefitsCache = new Map<
      string,
      { benefits: any[]; planName: string } | null
    >();
    const getBenefits = async (storeId: string) => {
      if (!benefitsCache.has(storeId)) {
        benefitsCache.set(
          storeId,
          await this.subscriptionBenefits.getActiveBenefits(userId, storeId),
        );
      }
      return benefitsCache.get(storeId);
    };

    let subscriberSavingsUSD = 0;

    // Pass 1: resolve product/variant, validate stock, and compute each
    // store's RAW (pre-discount) subtotal. A discount benefit's
    // `minOrderValueUSD` must be checked against the order value, but the
    // order value isn't known until every line in the cart has been priced —
    // so resolving and applying the discount in a single pass (as before)
    // meant `minOrderValueUSD` was accepted by the API/DTO but never actually
    // enforced; every subscriber discount applied unconditionally regardless
    // of cart size.
    const rawItems: Array<{ product: any; variant: any; cartItem: any }> = [];
    const storeSubtotals = new Map<string, number>();

    for (const cartItem of selectedItems) {
      const product = await productModel.findOne({
        _id: cartItem.productId,
        status: 'active',
        isDelete: false,
      });
      if (!product)
        throw new BadRequestException(
          `Product not found: ${cartItem.productId}`,
        );

      const variant = await productVariantModel.findOne({
        _id: cartItem.productVariantId,
        status: 'active',
        isDelete: false,
      });
      if (!variant)
        throw new BadRequestException(
          `Variant not found: ${cartItem.productVariantId}`,
        );

      if (product.type === 'physical') {
        hasPhysical = true;
        if (!variant.unlimitedStock && variant.stock < cartItem.quantity) {
          throw new BadRequestException(
            `Insufficient stock for: ${product.name}`,
          );
        }
      }

      rawItems.push({ product, variant, cartItem });
      storeSubtotals.set(
        product.storeId,
        this.round(
          (storeSubtotals.get(product.storeId) ?? 0) +
            variant.price * cartItem.quantity,
        ),
      );
    }

    // Pass 2: resolve subscriber pricing now that each store's raw subtotal is known.
    for (const { product, variant, cartItem } of rawItems) {
      // Subscriber pricing is resolved server-side only — the client never
      // supplies a discount, it can only ever be computed from the buyer's
      // real active subscription to this product's store.
      const benefitsEntry = await getBenefits(product.storeId);
      let discount = benefitsEntry
        ? this.subscriptionBenefits.resolveProductDiscount(
            benefitsEntry.benefits,
            product,
            variant.price,
          )
        : null;

      if (
        discount?.minOrderValueUSD != null &&
        (storeSubtotals.get(product.storeId) ?? 0) < discount.minOrderValueUSD
      ) {
        discount = null; // cart doesn't meet this store's minimum order value for the discount
      }

      const unitPrice = discount?.subscriberPrice ?? variant.price;
      const lineDiscount = discount
        ? this.round(discount.savingsUSD * cartItem.quantity)
        : 0;
      subscriberSavingsUSD += lineDiscount;

      checkoutItems.push({
        productId: product._id.toString(),
        variantId: variant._id.toString(),
        sellerId: product.sellerId,
        storeId: product.storeId,
        type: product.type,
        productType: product.productType ?? null,
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

    // Pass 3: automatic platform-campaign discount. Resolved per store — a
    // store can be opted into more than one currently-active campaign, so
    // whichever one currently saves the buyer the most on that store's
    // (already subscriber-priced) subtotal wins (see pickBestCampaign).
    // Applied on top of subscriber pricing, same as a "sale on top of your
    // membership price" would read to a buyer — never on the raw list price.
    let campaignSavingsUSD = 0;
    const appliedCampaigns: Array<{
      campaignId: string;
      name: string;
      storeId: string;
      discountUSD: number;
      sponsorType: 'seller' | 'platform';
    }> = [];
    const cartStoreIds = [...new Set(checkoutItems.map((i) => i.storeId))];
    const activeCampaignsByStore =
      await this.marketingService.getActiveCampaignsForStores(cartStoreIds);

    for (const storeId of cartStoreIds) {
      const campaigns = activeCampaignsByStore.get(storeId);
      if (!campaigns || campaigns.length === 0) continue;

      const storeItems = checkoutItems.filter((i) => i.storeId === storeId);
      const storeSubtotal = this.round(
        storeItems.reduce((s, i) => s + i.totalPrice, 0),
      );
      const best = pickBestCampaign(campaigns, storeSubtotal);
      if (!best || best.discountAmount <= 0) continue;

      this.distributeCampaignDiscount(
        storeItems,
        best.discountAmount,
        best.campaign.campaignId,
        best.campaign.sponsorType,
      );
      campaignSavingsUSD = this.round(campaignSavingsUSD + best.discountAmount);
      appliedCampaigns.push({
        campaignId: best.campaign.campaignId,
        name: best.campaign.name,
        storeId,
        discountUSD: best.discountAmount,
        sponsorType: best.campaign.sponsorType,
      });
    }

    let defaultAddressId: string | null = null;

    if (hasPhysical) {
      let defaultAddress = await addressModel.findOne({ userId, isDefault: true, isDelete: false });

      // Buyers aren't required to flag an address as default when saving
      // one, so a buyer with addresses but no explicit default would
      // otherwise be blocked from checking out entirely. Fall back to the
      // oldest saved address and promote it, repairing the missing-default
      // data so subsequent lookups (address list, getDefaultAddress) agree.
      if (!defaultAddress) {
        defaultAddress = await addressModel.findOne({ userId, isDelete: false }).sort({ createdAt: 1 });
        if (defaultAddress) {
          defaultAddress.isDefault = true;
          await defaultAddress.save();
        }
      }

      if (!defaultAddress) throw new BadRequestException('No default address found. Please set a default address first');
      defaultAddressId = defaultAddress._id.toString();
    }

    const subtotal = this.round(
      checkoutItems.reduce((sum, i) => sum + i.totalPrice, 0),
    );
    const taxAmount = 0;
    const totalAmount = this.round(subtotal + taxAmount);

    // Checkout-time upsell: for any store in this cart the buyer is NOT
    // subscribed to, but which has an active plan offering a discount,
    // surface what they'd have saved — the highest-intent moment to convert.
    const subscriptionSavingsHints: Array<{
      storeId: string;
      storeName: string;
      storeSlug: string;
      planId: string;
      planName: string;
      potentialSavingsUSD: number;
    }> = [];
    const storeIdsInCart = [...new Set(checkoutItems.map((i) => i.storeId))];
    for (const sid of storeIdsInCart) {
      if (benefitsCache.get(sid)) continue; // already subscribed here
      const plan = await this.databaseService.repositories.subscriptionPlanModel
        .findOne({
          storeId: sid,
          status: 'active',
          isDelete: false,
          'benefits.type': 'discount',
        })
        .sort({ monthlyPriceUSD: 1 })
        .lean();
      if (!plan) continue;
      const storeItems = checkoutItems.filter((i) => i.storeId === sid);
      let potentialSavings = 0;
      for (const item of storeItems) {
        const d = this.subscriptionBenefits.resolveProductDiscount(
          (plan as any).benefits,
          { _id: item.productId } as any,
          item.price,
        );
        if (d) potentialSavings += this.round(d.savingsUSD * item.quantity);
      }
      if (potentialSavings > 0) {
        const store = await this.databaseService.repositories.storeModel
          .findById(sid)
          .select('name slug')
          .lean();
        subscriptionSavingsHints.push({
          storeId: sid,
          storeName: (store as any)?.name ?? 'this store',
          storeSlug: (store as any)?.slug ?? '',
          planId: (plan as any)._id.toString(),
          planName: (plan as any).name,
          potentialSavingsUSD: this.round(potentialSavings),
        });
      }
    }

    // Client-reported attribution — a mobile app has no meaningful
    // Referer/UTM headers, so this can only ever be as good as what the app
    // itself reports (e.g. "opened via a shared product link"). Unknown or
    // invalid values fall back to 'other' rather than being rejected.
    const validAttributionSources = [
      'marketplace_search',
      'direct_link',
      'social_media',
      'email',
      'other',
    ];
    const attributionSource = validAttributionSources.includes(
      body.attributionSource,
    )
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
      campaignDiscountTotalUSD: campaignSavingsUSD,
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
        // A mixed cart can either pay everything online ('stripe') or split
        // it — digital online now, physical via COD on delivery ('split').
        // Digital-only carts never get COD; physical-only carts keep both
        // 'stripe' and 'cash_on_delivery' as before.
        allowedPaymentMethods: hasDigital
          ? (hasPhysical ? ['stripe', 'split'] : ['stripe'])
          : ['stripe', 'cash_on_delivery'],
        summary: {
          subtotal,
          shippingFee: 0,
          taxAmount,
          totalAmount,
          subscriberSavingsUSD: this.round(subscriberSavingsUSD),
          campaignDiscountUSD: campaignSavingsUSD,
          ...this.splitSubtotalsByType(checkoutItems),
        },
        subscriptionSavingsHints,
        appliedCampaigns,
      },
    };
  }

  async addShippingInCheckout(userId: string, body: any) {
    const { checkoutId, shippingZoneId } = body;

    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!shippingZoneId)
      throw new BadRequestException('shippingZoneId is required');

    const { checkoutModel, shippingZoneModel } =
      this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, {
        status: 'expired',
      });
      throw new BadRequestException('Checkout has expired');
    }

    const shippingZone = await shippingZoneModel.findOne({
      _id: shippingZoneId,
      isDelete: false,
    });
    if (!shippingZone) throw new NotFoundException('Shipping zone not found');

    let shippingFee = shippingZone.shippingPrice || 0;

    // Free/discounted shipping benefit — only applied when every item in the
    // checkout belongs to a single store (the shipping fee itself is a flat,
    // whole-checkout amount, not per-seller, so a mixed-store cart can't
    // unambiguously attribute the waiver to one store's membership).
    const storeIdsInCheckout = [
      ...new Set((checkout.items as any[]).map((i) => i.storeId)),
    ];
    if (storeIdsInCheckout.length === 1) {
      const benefitsEntry = await this.subscriptionBenefits.getActiveBenefits(
        userId,
        storeIdsInCheckout[0],
      );
      if (benefitsEntry) {
        const shippingBenefit =
          this.subscriptionBenefits.resolveShippingBenefit(
            benefitsEntry.benefits,
          );
        if (
          shippingBenefit &&
          (shippingBenefit.minOrderValueForShippingUSD == null ||
            checkout.subtotal >= shippingBenefit.minOrderValueForShippingUSD)
        ) {
          shippingFee = this.round(
            shippingFee * (1 - shippingBenefit.discountPercent / 100),
          );
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
        ...this.splitSubtotalsByType(checkout.items as any[]),
      },
    };
  }

  async getShippingZones() {
    try {
      const shippingZoneModel =
        this.databaseService.repositories.shippingZoneModel;

      // get all shipping zones
      const shippingZones = await shippingZoneModel
        .find({
          isDelete: false,
        })
        .sort({ createdAt: -1 });

      return {
        message: 'Shipping zones fetched successfully',
        data: shippingZones,
      };
    } catch (error) {
      throw error;
    }
  }

  /** Validates a seller-created coupon against this checkout and, if valid,
   *  distributes its discount across only the items belonging to the
   *  coupon's own store (a coupon never discounts another seller's items in
   *  a mixed-store cart). Replacing an already-applied coupon reverts the
   *  old one first so discounts never compound. */
  async applyCoupon(userId: string, body: any) {
    const { checkoutId, code } = body;
    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!code || !String(code).trim())
      throw new BadRequestException('Coupon code is required');

    const { checkoutModel, couponModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled')
      throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, {
        status: 'expired',
      });
      throw new BadRequestException('Checkout has expired');
    }

    const normalizedCode = String(code).trim().toUpperCase();
    const items = checkout.items as any[];
    const storeIdsInCheckout = [...new Set(items.map((i) => i.storeId))];

    const coupon = await couponModel.findOne({
      code: normalizedCode,
      storeId: { $in: storeIdsInCheckout },
      isActive: true,
      isDelete: false,
    });
    if (!coupon)
      throw new BadRequestException(
        'This coupon code is invalid or not applicable to items in your cart',
      );
    if (coupon.expiresAt && coupon.expiresAt < new Date())
      throw new BadRequestException('This coupon has expired');
    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }

    // Revert any previously-applied coupon first so re-applying (or
    // switching codes) always computes from a clean, undiscounted baseline.
    this.revertCouponFromItems(items);

    const storeItems = items.filter((i) => i.storeId === coupon.storeId);
    const storeSubtotal = this.round(
      storeItems.reduce((s, i) => s + i.totalPrice, 0),
    );

    if (
      coupon.minOrderAmount != null &&
      storeSubtotal < coupon.minOrderAmount
    ) {
      throw new BadRequestException(
        `This coupon requires a minimum order of $${coupon.minOrderAmount} from this store`,
      );
    }

    // Items already discounted by an active platform campaign ("sale" items)
    // don't stack with a coupon code on top — standard "not combinable with
    // other offers" rule, and it also keeps a line from being discounted
    // twice down toward/below $0. minOrderAmount above still checks the
    // buyer's full spend at the store, but the coupon itself only ever comes
    // out of the non-sale portion.
    const eligibleItems = storeItems.filter(
      (i) => !(i.campaignDiscountUSD > 0),
    );
    if (eligibleItems.length === 0) {
      throw new BadRequestException(
        "This coupon can't be combined with the active sale on these items.",
      );
    }
    const eligibleSubtotal = this.round(
      eligibleItems.reduce((s, i) => s + i.totalPrice, 0),
    );

    const totalDiscount =
      coupon.discountType === 'percentage'
        ? this.round(eligibleSubtotal * (coupon.discountValue / 100))
        : Math.min(coupon.discountValue, eligibleSubtotal);

    this.distributeCouponDiscount(eligibleItems, totalDiscount);

    const newSubtotal = this.round(items.reduce((s, i) => s + i.totalPrice, 0));
    const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
      subtotal: newSubtotal,
      totalAmount: newTotal,
      couponCode: normalizedCode,
      couponStoreId: coupon.storeId,
      couponDiscountTotalUSD: totalDiscount,
    });

    return {
      success: true,
      message: 'Coupon applied',
      data: {
        checkoutId,
        couponCode: normalizedCode,
        couponDiscountUSD: totalDiscount,
        subtotal: newSubtotal,
        shippingFee: checkout.shippingFee || 0,
        totalAmount: newTotal,
        ...this.splitSubtotalsByType(items),
      },
    };
  }

  async removeCoupon(userId: string, body: any) {
    const { checkoutId } = body;
    if (!checkoutId) throw new BadRequestException('checkoutId is required');

    const { checkoutModel } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');

    const items = checkout.items as any[];
    this.revertCouponFromItems(items);

    const newSubtotal = this.round(items.reduce((s, i) => s + i.totalPrice, 0));
    const newTotal = this.round(newSubtotal + (checkout.shippingFee || 0));

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      items: items.map((i: any) => (i.toObject ? i.toObject() : i)),
      subtotal: newSubtotal,
      totalAmount: newTotal,
      couponCode: null,
      couponStoreId: null,
      couponDiscountTotalUSD: 0,
    });

    return {
      success: true,
      message: 'Coupon removed',
      data: {
        checkoutId,
        subtotal: newSubtotal,
        shippingFee: checkout.shippingFee || 0,
        totalAmount: newTotal,
        ...this.splitSubtotalsByType(items),
      },
    };
  }

  /** Restores each item's pre-coupon price/totalPrice in place (mutates the
   *  passed array) — a no-op for items that never had a coupon applied. */
  private revertCouponFromItems(items: any[]) {
    for (const item of items) {
      if (item.totalPriceBeforeCoupon != null) {
        item.price = item.priceBeforeCoupon;
        item.totalPrice = item.totalPriceBeforeCoupon;
        item.priceBeforeCoupon = null;
        item.totalPriceBeforeCoupon = null;
        item.couponDiscountUSD = 0;
      }
    }
  }

  /** Splits [totalDiscount] proportionally across [items] by each item's
   *  share of their combined totalPrice, invoking [applyToItem] once per item
   *  with its allocated share. The last item absorbs the rounding remainder
   *  so per-item shares always sum to `totalDiscount` exactly. Shared math
   *  behind both coupon and campaign discount application — only the fields
   *  each writes differ, not the allocation itself. */
  private proportionallyDistribute(
    items: any[],
    totalDiscount: number,
    applyToItem: (item: any, share: number) => void,
  ) {
    if (totalDiscount <= 0 || items.length === 0) return;
    const combinedSubtotal = items.reduce((s, i) => s + i.totalPrice, 0);
    if (combinedSubtotal <= 0) return;

    let allocated = 0;
    items.forEach((item, idx) => {
      const isLast = idx === items.length - 1;
      const share = isLast
        ? this.round(totalDiscount - allocated)
        : this.round(totalDiscount * (item.totalPrice / combinedSubtotal));
      allocated = this.round(allocated + share);
      applyToItem(item, share);
    });
  }

  /** Distributes a coupon's discount across the items it applies to, mutating
   *  price/totalPrice in place and keeping the pre-coupon baseline so
   *  removing/replacing a coupon can cleanly revert without compounding. */
  private distributeCouponDiscount(storeItems: any[], totalDiscount: number) {
    this.proportionallyDistribute(storeItems, totalDiscount, (item, share) => {
      item.priceBeforeCoupon = item.price;
      item.totalPriceBeforeCoupon = item.totalPrice;
      item.couponDiscountUSD = share;
      item.totalPrice = this.round(item.totalPrice - share);
      item.price =
        item.quantity > 0
          ? this.round(item.totalPrice / item.quantity)
          : item.totalPrice;
    });
  }

  /** Distributes an automatic platform-campaign discount across a store's
   *  items, mutating price/totalPrice in place. Unlike a coupon, a campaign
   *  discount is never toggled off by the buyer, so it needs no "before"
   *  revert fields — it's simply recomputed fresh every time a checkout is
   *  (re)created from the cart. `originalPrice` is set only if a subscriber
   *  discount hasn't already set it, so it always reflects the true pre-any-
   *  discount price for receipt display. */
  private distributeCampaignDiscount(
    storeItems: any[],
    totalDiscount: number,
    campaignId: string,
    sponsorType: 'seller' | 'platform',
  ) {
    this.proportionallyDistribute(storeItems, totalDiscount, (item, share) => {
      if (item.originalPrice == null) item.originalPrice = item.price;
      item.campaignId = campaignId;
      item.campaignDiscountUSD = share;
      item.campaignSponsorType = sponsorType;
      item.totalPrice = this.round(item.totalPrice - share);
      item.price =
        item.quantity > 0
          ? this.round(item.totalPrice / item.quantity)
          : item.totalPrice;
    });
  }
}
