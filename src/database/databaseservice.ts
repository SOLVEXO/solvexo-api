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
    @InjectModel(schema.Banner.name)
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

    @InjectModel(schema.StoreFollower.name)
    private storeFollowerModel: Model<schema.StoreFollowerDocument>,

    @InjectModel(schema.Employee.name)
    private employeeModel: Model<schema.EmployeeDocument>,

    @InjectModel(schema.RegisterSession.name)
    private registerSessionModel: Model<schema.RegisterSessionDocument>,

    @InjectModel(schema.Sale.name)
    private saleModel: Model<schema.SaleDocument>,

    @InjectModel(schema.PosAuditLog.name)
    private posAuditLogModel: Model<schema.PosAuditLogDocument>,

    @InjectModel(schema.PosSettings.name)
    private posSettingsModel: Model<schema.PosSettingsDocument>,

    @InjectModel(schema.Conversation.name)
    private conversationModel: Model<schema.ConversationDocument>,

    @InjectModel(schema.Message.name)
    private messageModel: Model<schema.MessageDocument>,

    @InjectModel(schema.Block.name)
    private blockModel: Model<schema.BlockDocument>,

    @InjectModel(schema.Report.name)
    private reportModel: Model<schema.ReportDocument>,

    @InjectModel(schema.SellerBalance.name)
    private sellerBalanceModel: Model<schema.SellerBalanceDocument>,

    @InjectModel(schema.Transaction.name)
    private transactionModel: Model<schema.TransactionDocument>,

    @InjectModel(schema.Payout.name)
    private payoutModel: Model<schema.PayoutDocument>,

    @InjectModel(schema.PayoutMethod.name)
    private payoutMethodModel: Model<schema.PayoutMethodDocument>,

    @InjectModel(schema.PayoutSchedule.name)
    private payoutScheduleModel: Model<schema.PayoutScheduleDocument>,

    @InjectModel(schema.TaxReport.name)
    private taxReportModel: Model<schema.TaxReportDocument>,

    @InjectModel(schema.SubscriptionPlan.name)
    private subscriptionPlanModel: Model<schema.SubscriptionPlanDocument>,

    @InjectModel(schema.Subscription.name)
    private subscriptionModel: Model<schema.SubscriptionDocument>,

    @InjectModel(schema.SubscriptionInvoice.name)
    private subscriptionInvoiceModel: Model<schema.SubscriptionInvoiceDocument>,

    @InjectModel(schema.ActivityLog.name)
    private activityLogModel: Model<schema.ActivityLogDocument>,

    @InjectModel(schema.Coupon.name)
    private couponModel: Model<schema.CouponDocument>,

    @InjectModel(schema.LoyaltyProgram.name)
    private loyaltyProgramModel: Model<schema.LoyaltyProgramDocument>,

    @InjectModel(schema.LoyaltyMember.name)
    private loyaltyMemberModel: Model<schema.LoyaltyMemberDocument>,

    @InjectModel(schema.LoyaltyTransaction.name)
    private loyaltyTransactionModel: Model<schema.LoyaltyTransactionDocument>,

    @InjectModel(schema.Reward.name)
    private rewardModel: Model<schema.RewardDocument>,

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
      storeFollowerModel: this.storeFollowerModel,
      employeeModel: this.employeeModel,
      registerSessionModel: this.registerSessionModel,
      saleModel: this.saleModel,
      posAuditLogModel: this.posAuditLogModel,
      posSettingsModel: this.posSettingsModel,
      conversationModel: this.conversationModel,
      messageModel: this.messageModel,
      blockModel: this.blockModel,
      reportModel: this.reportModel,
      sellerBalanceModel: this.sellerBalanceModel,
      transactionModel: this.transactionModel,
      payoutModel: this.payoutModel,
      payoutMethodModel: this.payoutMethodModel,
      payoutScheduleModel: this.payoutScheduleModel,
      taxReportModel: this.taxReportModel,
      subscriptionPlanModel: this.subscriptionPlanModel,
      subscriptionModel: this.subscriptionModel,
      subscriptionInvoiceModel: this.subscriptionInvoiceModel,
      activityLogModel: this.activityLogModel,
      couponModel: this.couponModel,
      loyaltyProgramModel: this.loyaltyProgramModel,
      loyaltyMemberModel: this.loyaltyMemberModel,
      loyaltyTransactionModel: this.loyaltyTransactionModel,
      rewardModel: this.rewardModel,
    };
  }
}