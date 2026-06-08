/* eslint-disable prettier/prettier */
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as schema from "./schema";

@Injectable()
export class DatabaseService {
  constructor(
    @InjectModel(schema.User.name)
    private userModel: Model<schema.UserDocument>,
    @InjectModel(schema.Seller.name)
    private sellerModel: Model<schema.SellerDocument>,
    @InjectModel(schema.Admin.name)
    private adminModel: Model<schema.AdminDocument>,
    @InjectModel(schema.Category.name)
    private categoryModel: Model<schema.CategoryDocument>,
    @InjectModel(schema.Product.name)
    private productModel: Model<schema.ProductDocument>,

      @InjectModel(schema.ProductVariant.name)
    private productVariantModel: Model<schema.ProductVariantDocument>,
 

    @InjectModel(schema.User.name)
    private otpModel: Model<schema.OtpDocument>,
    @InjectModel(schema.User.name)
    private bannerModel: Model<schema.BannerDocument>,
    @InjectModel(schema.User.name)
    private faqModel: Model<schema.FaqDocument>,


     @InjectModel(schema.Cart.name)
    private cartModel: Model<schema.CartDocument>,

    @InjectModel(schema.wishList.name)
    private wishListModel: Model<schema.wishListDocument>,

    @InjectModel(schema.Rating.name)
    private ratingModel: Model<schema.RatingDocument>,

    @InjectModel(schema.Address.name)
    private addressModel: Model<schema.AddressDocument>,

    @InjectModel(schema.UserPaymentMethod.name)
    private userPaymentMethodModel: Model<schema.UserPaymentMethodDocument>,

    @InjectModel(schema.ShippingZone.name)
    private shippingZoneModel: Model<schema.ShippingZoneDocument>,  

    @InjectModel(schema.Checkout.name)
    private checkoutModel: Model<schema.CheckoutDocument>,
    
    @InjectModel(schema.Order.name)
    private orderModel: Model<schema.OrderDocument>,

    @InjectModel(schema.PaymentTransaction.name)
    private paymentTransactionModel: Model<schema.PaymentTransactionDocument>,

    @InjectModel(schema.Store.name)
    private storeModel: Model<schema.StoreDocument>,

  ) { }

  get repositories() {
    return {
      userModel: this.userModel,
      sellerModel: this.sellerModel,
      adminModel: this.adminModel,
      categoryModel: this.categoryModel,
      productModel: this.productModel,
      productVariantModel: this.productVariantModel,
      otpModel: this.otpModel,
      bannerModel: this.bannerModel,
      faqModel: this.faqModel,
        
      cartModel: this.cartModel,
      wishListModel: this.wishListModel,
      ratingModel: this.ratingModel,
      addressModel: this.addressModel,
      userPaymentMethodModel: this.userPaymentMethodModel,
      shippingZoneModel: this.shippingZoneModel,
      checkoutModel: this.checkoutModel,
      orderModel: this.orderModel,
      paymentTransactionModel: this.paymentTransactionModel,
      storeModel: this.storeModel,
    };
  }
}