/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ManualPaymentsService } from './manual-payments.service';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { PaymentService } from '../payment/payment.service';
import { FinanceService } from '../finance/finance.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';

const USER_ID = 'user-1';
const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';
const FAKE_FILE = { originalname: 'receipt.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('x') } as any;

function makeSellerOrder(overrides: Partial<Record<string, any>> = {}) {
  return {
    storeId: STORE_ID, sellerId: SELLER_ID, subtotal: 100, platformSponsoredDiscountUSD: 0,
    items: [{ campaignSponsorType: null, campaignId: null }],
    ...overrides,
  };
}

describe('ManualPaymentsService', () => {
  let service: ManualPaymentsService;
  let proofModel: any;
  let orderModel: any;
  let userModel: any;
  let storeModel: any;
  let storeIntegrationModel: any;
  let uploadService: UploadService;
  let paymentService: PaymentService;
  let financeService: FinanceService;
  let exchangeRateService: ExchangeRateService;
  let activityLogService: ActivityLogService;
  let notificationsService: NotificationsService;

  beforeEach(() => {
    proofModel = { create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) }) }), countDocuments: jest.fn().mockResolvedValue(0) };
    orderModel = { find: jest.fn(), findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
    userModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    storeModel = { findById: jest.fn().mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false }) };
    storeIntegrationModel = { findOne: jest.fn() };

    const db = { repositories: { manualPaymentProofModel: proofModel, orderModel, userModel, storeModel, storeIntegrationModel } } as unknown as DatabaseService;

    uploadService = { uploadFile: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/proof.jpg', publicId: 'p1', resourceType: 'image' }) } as any;
    paymentService = { manualBankTransferPayment: jest.fn() } as any;
    financeService = { recordSale: jest.fn().mockResolvedValue(undefined) } as any;
    exchangeRateService = { getCurrentRate: jest.fn().mockResolvedValue({ ratePerUSD: 278 }) } as any;
    activityLogService = { log: jest.fn() } as any;
    notificationsService = { notify: jest.fn().mockResolvedValue(undefined) } as any;

    service = new ManualPaymentsService(db, uploadService, paymentService, financeService, exchangeRateService, activityLogService, notificationsService);
  });

  describe('getBankDetails', () => {
    it('throws when this store has no bank_transfer integration connected', async () => {
      storeIntegrationModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
      await expect(service.getBankDetails(STORE_ID)).rejects.toThrow(BadRequestException);
    });

    it("returns the store's own bank details plus the live FX rate", async () => {
      storeIntegrationModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ config: { bankName: 'Meezan', accountTitle: 'Acme Store', accountNumber: '123' } }),
      });
      const result = await service.getBankDetails(STORE_ID);
      expect(result.bankName).toBe('Meezan');
      expect(result.usdToPkrRate).toBe(278);
    });
  });

  describe('submitPayment', () => {
    it('rejects a submission with no file attached', async () => {
      await expect(service.submitPayment(USER_ID, { checkoutId: 'c1' } as any, undefined)).rejects.toThrow(BadRequestException);
    });

    it('places the order via PaymentService, uploads the proof, and records both USD and PKR amounts', async () => {
      const orders = [{ _id: 'order-1', orderNumber: 'ORD-1', totalAmount: 27800, currency: 'PKR', sellerOrders: [{ storeId: STORE_ID }] }];
      paymentService.manualBankTransferPayment = jest.fn().mockResolvedValue({ orders, amountUSD: 100, amountPKR: 27800, fxRate: 278 });
      proofModel.create.mockImplementation(async (doc: any) => ({ ...doc, _id: 'proof-1' }));

      const result = await service.submitPayment(USER_ID, { checkoutId: 'c1', transactionReference: 'TXN1' } as any, FAKE_FILE);

      expect(paymentService.manualBankTransferPayment).toHaveBeenCalledWith(USER_ID, 'c1');
      expect(uploadService.uploadFile).toHaveBeenCalledWith(FAKE_FILE);
      expect(proofModel.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: USER_ID, checkoutId: 'c1', amountUSD: 100, amountPKR: 27800, fxRateUsed: 278,
        proofImageUrl: 'https://cdn.example.com/proof.jpg', transactionReference: 'TXN1', status: 'pending',
      }));
      expect(result.proof._id).toBe('proof-1');
      expect(notificationsService.notify).toHaveBeenCalled();
    });
  });

  describe('reuploadPayment', () => {
    it('throws NotFoundException when the proof does not belong to this user', async () => {
      proofModel.findOne.mockResolvedValue(null);
      await expect(service.reuploadPayment(USER_ID, 'p1', {}, FAKE_FILE)).rejects.toThrow(NotFoundException);
    });

    it('rejects a re-upload attempt on a proof that is not currently rejected', async () => {
      proofModel.findOne.mockResolvedValue({ status: 'pending' });
      await expect(service.reuploadPayment(USER_ID, 'p1', {}, FAKE_FILE)).rejects.toThrow(BadRequestException);
    });

    it('resets a rejected proof back to pending with the new image and increments reuploadCount', async () => {
      const proof: any = { status: 'rejected', rejectionReason: 'bad amount', reuploadCount: 1, save: jest.fn() };
      proofModel.findOne.mockResolvedValue(proof);

      await service.reuploadPayment(USER_ID, 'p1', { transactionReference: 'TXN2' } as any, FAKE_FILE);

      expect(proof.status).toBe('pending');
      expect(proof.rejectionReason).toBeNull();
      expect(proof.reuploadCount).toBe(2);
      expect(proof.proofImageUrl).toBe('https://cdn.example.com/proof.jpg');
      expect(proof.save).toHaveBeenCalled();
    });
  });

  describe('sellerApprove', () => {
    it('throws ForbiddenException when the acting seller does not own this store', async () => {
      storeModel.findById.mockResolvedValue({ _id: STORE_ID, sellerId: 'someone-else', isDelete: false });
      await expect(service.sellerApprove(STORE_ID, SELLER_ID, 'p1')).rejects.toThrow(ForbiddenException);
    });

    it('throws when the proof is not pending', async () => {
      proofModel.findOne.mockResolvedValue({ status: 'approved' });
      await expect(service.sellerApprove(STORE_ID, SELLER_ID, 'p1')).rejects.toThrow(BadRequestException);
    });

    it('marks every affected order paid, credits the seller via FinanceService, and approves the proof', async () => {
      const order = { _id: 'order-1', currency: 'PKR', sellerOrders: [makeSellerOrder()] };
      proofModel.findOne.mockResolvedValue({ status: 'pending', orderIds: ['order-1'], amountPKR: 27800, userId: USER_ID, save: jest.fn() });
      orderModel.find.mockResolvedValue([order]);

      await service.sellerApprove(STORE_ID, SELLER_ID, 'p1');

      expect(orderModel.findByIdAndUpdate).toHaveBeenCalledWith('order-1', expect.objectContaining({
        $set: expect.objectContaining({ isPaid: true, paymentStatus: 'paid', orderStatus: 'completed' }),
      }));
      expect(financeService.recordSale).toHaveBeenCalledWith(
        STORE_ID, SELLER_ID, 'order-1', 100, expect.any(String), 0, null, 'PKR', 'manual_bank_transfer',
      );
      expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'manual_payment_approved', storeId: STORE_ID }));
      expect(notificationsService.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual_payment_approved' }));
    });
  });

  describe('sellerReject', () => {
    it('throws NotFoundException for a missing proof', async () => {
      proofModel.findOne.mockResolvedValue(null);
      await expect(service.sellerReject(STORE_ID, SELLER_ID, 'missing', 'reason')).rejects.toThrow(NotFoundException);
    });

    it('marks the proof rejected with the given reason and notifies the buyer', async () => {
      const proof: any = { status: 'pending', amountPKR: 27800, userId: USER_ID, save: jest.fn() };
      proofModel.findOne.mockResolvedValue(proof);

      await service.sellerReject(STORE_ID, SELLER_ID, 'p1', 'Amount mismatch');

      expect(proof.status).toBe('rejected');
      expect(proof.rejectionReason).toBe('Amount mismatch');
      expect(notificationsService.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual_payment_rejected' }));
    });
  });
});
