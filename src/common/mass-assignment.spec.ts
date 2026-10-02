/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AddressService } from '../address/address.service';
import { DiscountsService } from '../discounts/discounts.service';
import { DatabaseService } from '../database/databaseservice';

/**
 * These handlers receive the RAW request body (their DTOs are type-only or
 * the controller takes `any`), so each must pick its own allowed fields —
 * otherwise `$set: body` lets a caller overwrite privileged fields.
 */

describe('AuthService.editProfile — field whitelist', () => {
  let service: AuthService;
  let userModel: any;

  beforeEach(() => {
    const chain: any = { select: jest.fn().mockResolvedValue({ _id: 'u1', name: 'New Name' }) };
    userModel = { findByIdAndUpdate: jest.fn().mockReturnValue(chain) };
    const db = { repositories: { userModel, sellerModel: userModel, adminModel: userModel, platformConfigModel: { findOne: () => ({ lean: () => Promise.resolve(null) }) } } } as unknown as DatabaseService;
    service = new AuthService(db, {} as any, {} as any, {} as any, {} as any);
  });

  it('REGRESSION: privileged fields in the body are never written', async () => {
    const hostile: any = {
      name: 'New Name', phone: '123', address: 'Somewhere', profileImage: 'img', fcmToken: 'tok',
      status: 'active', isVerified: true, tokenVersion: 0, password: 'plaintext', role: 'admin',
      stripeCustomerId: 'cus_victim', stripeConnectedAccountId: 'acct_x', platformTrialUsedAt: null,
      storeId: 'another-store', otp: '000000', isDelete: false,
    };

    await service.editProfile('u1', 'user', hostile);

    const [id, update] = userModel.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('u1');
    expect(Object.keys(update.$set).sort()).toEqual(['address', 'fcmToken', 'name', 'phone', 'profileImage']);
  });

  it('only sends fields that were actually provided', async () => {
    await service.editProfile('u1', 'user', { name: 'Only Name' } as any);
    expect(userModel.findByIdAndUpdate.mock.calls[0][1]).toEqual({ $set: { name: 'Only Name' } });
  });
});

describe('AuthService.emailScope — rejects non-string email/storeId (NoSQL operator injection)', () => {
  const scope = (email: any, role: string, storeId?: any) =>
    (new AuthService({} as any, {} as any, {} as any, {} as any, {} as any) as any).emailScope(email, role, storeId);

  it('builds a per-store filter for buyers and a plain email filter otherwise', () => {
    expect(scope(' Jane@Example.com ', 'user', 'store-1')).toEqual({ email: 'jane@example.com', storeId: 'store-1' });
    expect(scope('jane@example.com', 'user')).toEqual({ email: 'jane@example.com', storeId: null });
    expect(scope('s@example.com', 'seller', 'store-1')).toEqual({ email: 's@example.com' });
  });

  it.each([[{ $ne: null }], [{ $gt: '' }], [['a@b.com']], [undefined], [null], [123]])('REGRESSION: rejects email %p', (bad) => {
    expect(() => scope(bad, 'user', 'store-1')).toThrow(BadRequestException);
  });

  it.each([[{ $ne: null }], [{ $exists: true }], [['store-1']], [42]])('REGRESSION: rejects storeId %p', (bad) => {
    expect(() => scope('jane@example.com', 'user', bad)).toThrow(BadRequestException);
  });
});

describe('AddressService.updateAddress — field whitelist', () => {
  let service: AddressService;
  let addressModel: any;

  beforeEach(() => {
    addressModel = { findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'a1' }) };
    service = new AddressService({ repositories: { addressModel } } as unknown as DatabaseService);
  });

  it('REGRESSION: cannot re-parent or revive an address through the body', async () => {
    await service.updateAddress('user-1', 'addr-1', {
      city: 'Lahore', zipCode: '54000', isDefault: true,
      userId: 'someone-else', isDelete: true, status: 'inactive', _id: 'x',
    });

    const [filter, update] = addressModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'addr-1', userId: 'user-1', isDelete: false });
    expect(update).toEqual({ $set: { city: 'Lahore', zipCode: '54000', isDefault: true } });
  });

  it('does not update an already-deleted address', async () => {
    addressModel.findOneAndUpdate.mockResolvedValue(null);
    const res = await service.updateAddress('user-1', 'addr-1', { city: 'x' });
    expect(res.message).toBe('Address not found');
  });
});

describe('DiscountsService.updateDiscount — field whitelist', () => {
  let service: DiscountsService;
  let automaticDiscountModel: any;

  beforeEach(() => {
    automaticDiscountModel = { findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'd1', name: 'Sale' }) };
    const storeModel = { findOne: jest.fn().mockResolvedValue({ _id: 'store-1' }) };
    service = new DiscountsService(
      { repositories: { automaticDiscountModel, storeModel } } as unknown as DatabaseService,
      { log: jest.fn() } as any,
    );
  });

  it('REGRESSION: a seller cannot move a discount to another store or un-delete it', async () => {
    const hostile: any = {
      name: 'Summer', discountValue: 10, discountType: 'percentage', isActive: true,
      storeId: 'victim-store', isDelete: false, usageCount: 0, sellerId: 'x',
    };

    await service.updateDiscount('seller-1', 'store-1', 'd1', hostile);

    const [filter, update] = automaticDiscountModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'd1', storeId: 'store-1', isDelete: false });
    expect(Object.keys(update.$set).sort()).toEqual(['discountType', 'discountValue', 'isActive', 'name']);
  });

  it('still converts startsAt/endsAt to Dates (and null clears them)', async () => {
    await service.updateDiscount('seller-1', 'store-1', 'd1', { startsAt: '2026-01-01', endsAt: '' } as any);
    const { $set } = automaticDiscountModel.findOneAndUpdate.mock.calls[0][1];
    expect($set.startsAt).toEqual(new Date('2026-01-01'));
    expect($set.endsAt).toBeNull();
  });
});
