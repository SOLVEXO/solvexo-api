/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { PosService } from './pos.service';

/**
 * Phase 5A rules for the sale pipeline, tested against hand-rolled repository fakes (no database):
 *  - stock is reserved all-or-nothing BEFORE a sale exists, and handed back on any failure
 *  - the idempotency-key race loser returns the winner's sale and takes no stock
 *  - held-sale double-complete, double-refund and double-void are rejected (status-guarded claim)
 *  - refund/void never put stock back on unlimited-stock variants
 *  - one open session per register (DB unique index surfaces as a friendly 400)
 *  - customer search only reaches people who relate to the store
 */
const lean = <T>(v: T) => ({ lean: () => Promise.resolve(v), select: () => ({ lean: () => Promise.resolve(v) }) });
const chain = <T>(v: T) => { const c: any = Promise.resolve(v); c.select = () => c; c.lean = () => Promise.resolve(v); c.session = () => c; c.sort = () => c; return c; };

function makeRepos(over: Record<string, any> = {}) {
  const variant = { _id: 'v1', productId: 'p1', sku: 'SKU1', price: 10, stock: 5, committedStock: 0, unlimitedStock: false, options: [] };
  const r: any = {
    storeModel: { findOne: jest.fn().mockResolvedValue({ _id: 's1', registers: [{ _id: 'reg1', locationId: null }] }), findById: jest.fn().mockReturnValue(lean(null)) },
    saleModel: {
      findOne: jest.fn().mockReturnValue(lean(null)),
      findById: jest.fn(),
      create: jest.fn().mockImplementation((d: any) => Promise.resolve({ _id: 'sale1', ...d })),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      distinct: jest.fn().mockResolvedValue([]),
    },
    registerSessionModel: {
      findOne: jest.fn().mockResolvedValue({ _id: 'sess1', storeId: 's1', locationId: null }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
      findOneAndUpdate: jest.fn(),
      create: jest.fn(),
    },
    employeeModel: { findOne: jest.fn().mockResolvedValue({ _id: 'e1' }), findById: jest.fn() },
    productVariantModel: {
      findOne: jest.fn().mockResolvedValue(variant),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1, matchedCount: 1 }),
      findByIdAndUpdate: jest.fn().mockResolvedValue({}),
      exists: jest.fn().mockResolvedValue({ _id: 'v1' }),
      find: jest.fn().mockReturnValue(chain([])),
    },
    productModel: { findOne: jest.fn().mockReturnValue({ select: () => Promise.resolve({ name: 'Tea', gallery: [] }) }) },
    posSettingsModel: { findOneAndUpdate: jest.fn().mockResolvedValue({ saleCounter: 1 }), findOne: jest.fn().mockReturnValue(lean(null)) },
    variantLocationStockModel: { find: jest.fn().mockReturnValue(chain([])) },
    posAuditLogModel: { create: jest.fn().mockResolvedValue({}) },
    orderModel: { aggregate: jest.fn().mockResolvedValue([]) },
    userModel: { find: jest.fn().mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) },
    ...over,
  };
  return r;
}

function build(r: any) {
  const service = new PosService({ repositories: r } as any, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  return service;
}

const saleDto = (over: any = {}) => ({
  storeId: 's1', sessionId: 'sess1', registerId: 'reg1', employeeId: 'e1',
  items: [{ productId: 'p1', variantId: 'v1', qty: 2 }],
  paymentMethod: 'cash', idempotencyKey: 'k1', ...over,
});

describe('PosService — Phase 5A sale integrity', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret'; });

  describe('createSale', () => {
    it('rejects a sale when a later line loses the stock race and gives back what the first line took (no sale written)', async () => {
      const r = makeRepos();
      r.productVariantModel.findOne.mockResolvedValue({ _id: 'x', sku: 'S', price: 10, stock: 9, unlimitedStock: false, options: [] });
      r.productVariantModel.updateOne
        .mockResolvedValueOnce({ modifiedCount: 1, matchedCount: 1 }) // line 1 reserved
        .mockResolvedValueOnce({ modifiedCount: 0, matchedCount: 0 }) // line 2 guard lost
        .mockResolvedValue({ modifiedCount: 1, matchedCount: 1 });    // compensation $inc
      const dto = saleDto({ items: [{ productId: 'p1', variantId: 'vA', qty: 1 }, { productId: 'p1', variantId: 'vB', qty: 1 }] });

      await expect(build(r).createSale('seller1', dto as any, undefined)).rejects.toBeInstanceOf(BadRequestException);

      expect(r.saleModel.create).not.toHaveBeenCalled();
      // the compensation put line 1's unit back
      expect(r.productVariantModel.updateOne).toHaveBeenCalledWith({ _id: 'vA' }, { $inc: { stock: 1 } });
    });

    it('gives the stock back and returns the winner when a concurrent request with the same key wins the unique index', async () => {
      const r = makeRepos();
      const winner = { _id: 'winner', idempotencyKey: 'k1' };
      r.saleModel.findOne.mockReturnValueOnce(lean(null)).mockReturnValueOnce(lean(winner));
      r.saleModel.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000, keyPattern: { idempotencyKey: 1 } }));

      const res: any = await build(r).createSale('seller1', saleDto() as any, undefined);

      expect(res.data).toBe(winner);
      expect(r.productVariantModel.updateOne).toHaveBeenCalledWith({ _id: 'v1' }, { $inc: { stock: 2 } }); // released
    });

    it('returns the existing sale for a plain retry without touching stock', async () => {
      const r = makeRepos();
      const existing = { _id: 'old' };
      r.saleModel.findOne.mockReturnValue(lean(existing));
      const res: any = await build(r).createSale('seller1', saleDto() as any, undefined);
      expect(res.data).toBe(existing);
      expect(r.productVariantModel.updateOne).not.toHaveBeenCalled();
      expect(r.saleModel.create).not.toHaveBeenCalled();
    });

    it('refuses a session that belongs to another store', async () => {
      const r = makeRepos();
      r.registerSessionModel.findOne.mockResolvedValue({ _id: 'sess1', storeId: 'OTHER' });
      await expect(build(r).createSale('seller1', saleDto() as any, undefined)).rejects.toThrow('Session does not belong to this store');
      expect(r.productVariantModel.updateOne).not.toHaveBeenCalled();
    });

    it('does not reserve stock for a held sale', async () => {
      const r = makeRepos();
      await build(r).createSale('seller1', saleDto({ status: 'held' }) as any, undefined);
      expect(r.productVariantModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('completeSale', () => {
    const held = { _id: 'sale1', status: 'held', storeId: 's1', sessionId: 'sess1', subtotal: 20, discount: 0, tax: 0, locationId: null,
      items: [{ variantId: 'v1', qty: 2, sku: 'SKU1' }] };

    it('rejects the loser of a double-complete and returns its stock', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(held);
      r.saleModel.findOneAndUpdate.mockResolvedValue(null); // the other terminal already claimed it

      await expect(build(r).completeSale('seller1', 'sale1', { paymentMethod: 'cash' } as any, undefined)).rejects.toBeInstanceOf(ConflictException);

      expect(r.saleModel.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'sale1', status: 'held' }, expect.anything(), expect.anything());
      expect(r.productVariantModel.updateOne).toHaveBeenCalledWith({ _id: 'v1' }, { $inc: { stock: 2 } });
      expect(r.registerSessionModel.findByIdAndUpdate).not.toHaveBeenCalled(); // no double count
    });

    it('completes once: stock taken once, session counted once', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(held);
      r.saleModel.findOneAndUpdate.mockResolvedValue({ _id: 'sale1', status: 'completed', total: 20 });
      await build(r).completeSale('seller1', 'sale1', { paymentMethod: 'cash' } as any, undefined);
      expect(r.registerSessionModel.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('refundSale', () => {
    const managerToken = () => jwt.sign({ employeeId: 'e1', storeId: 's1', role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
    const completed = () => ({ _id: 'sale1', status: 'completed', storeId: 's1', sessionId: 'sess1', total: 20, refundedAmount: 0, paymentMethod: 'cash', locationId: null,
      items: [{ _id: { toString: () => '507f1f77bcf86cd799439011' }, variantId: 'v1', qty: 2, refundedQty: 0, price: 10, name: 'Tea' }] });

    it('rejects a concurrent second refund (sale changed since read) and restores no stock', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(completed());
      r.saleModel.findOneAndUpdate.mockResolvedValue(null);
      await expect(build(r).refundSale('seller1', 'sale1', undefined, managerToken())).rejects.toBeInstanceOf(ConflictException);
      expect(r.productVariantModel.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(r.registerSessionModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('claims with the state it read (status + refundedAmount) so only one refund can win', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(completed());
      r.saleModel.findOneAndUpdate.mockResolvedValue({});
      await build(r).refundSale('seller1', 'sale1', undefined, managerToken());
      expect(r.saleModel.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'sale1', status: 'completed', refundedAmount: 0 });
    });

    it('does not inflate stock of an unlimited-stock variant on refund', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(completed());
      r.saleModel.findOneAndUpdate.mockResolvedValue({});
      r.productVariantModel.find.mockReturnValue(chain([{ _id: 'v1' }])); // v1 is unlimited
      await build(r).refundSale('seller1', 'sale1', undefined, managerToken());
      expect(r.productVariantModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('restores stock for a normal tracked variant', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(completed());
      r.saleModel.findOneAndUpdate.mockResolvedValue({});
      await build(r).refundSale('seller1', 'sale1', undefined, managerToken());
      expect(r.productVariantModel.findByIdAndUpdate).toHaveBeenCalledWith('v1', { $inc: { stock: 2 } });
    });
  });

  describe('voidSale', () => {
    const managerToken = () => jwt.sign({ employeeId: 'e1', storeId: 's1', role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
    const sale = { _id: 'sale1', status: 'completed', storeId: 's1', sessionId: 'sess1', total: 20, paymentMethod: 'cash', refundedAmount: 0, locationId: null,
      items: [{ variantId: 'v1', qty: 2 }] };

    it('only the request that wins completed→voided restores stock', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(sale);
      r.saleModel.findOneAndUpdate.mockResolvedValue(null);
      await expect(build(r).voidSale('seller1', 'sale1', {}, managerToken())).rejects.toBeInstanceOf(ConflictException);
      expect(r.productVariantModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('skips unlimited-stock variants', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue(sale);
      r.saleModel.findOneAndUpdate.mockResolvedValue({});
      r.productVariantModel.find.mockReturnValue(chain([{ _id: 'v1' }]));
      await build(r).voidSale('seller1', 'sale1', {}, managerToken());
      expect(r.productVariantModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('discardHeldSale', () => {
    it('is status-guarded so it cannot delete a sale that just became real', async () => {
      const r = makeRepos();
      r.saleModel.findById.mockResolvedValue({ _id: 'sale1', status: 'held', storeId: 's1' });
      r.saleModel.findOneAndDelete.mockResolvedValue(null);
      await expect(build(r).discardHeldSale('seller1', 'sale1')).rejects.toBeInstanceOf(ConflictException);
      expect(r.saleModel.findOneAndDelete).toHaveBeenCalledWith({ _id: 'sale1', status: 'held' });
    });
  });

  describe('sessions', () => {
    it('openSession turns a unique-index violation (two terminals at once) into a clear 400', async () => {
      const r = makeRepos();
      r.registerSessionModel.findOne.mockResolvedValue(null);
      r.registerSessionModel.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
      await expect(build(r).openSession('seller1', { storeId: 's1', registerId: 'reg1', employeeId: 'e1', openingCash: 0 } as any))
        .rejects.toThrow('Register already has an open session');
    });

    it('closeSession cannot close twice', async () => {
      const r = makeRepos();
      r.registerSessionModel.findOne.mockResolvedValue({ _id: 'sess1', storeId: 's1', openingCash: 0, cashSales: 0, cashAdjustments: [] });
      r.registerSessionModel.findOneAndUpdate.mockResolvedValue(null);
      await expect(build(r).closeSession('seller1', { sessionId: 'sess1', closingCash: 0 } as any)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('searchStoreCustomers', () => {
    it('only searches users who ordered from, or were sold to by, this store', async () => {
      const r = makeRepos();
      const orderedId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
      const posId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
      r.orderModel.aggregate.mockResolvedValue([{ _id: orderedId }]);
      r.saleModel.distinct.mockResolvedValue([posId]);
      const find = jest.fn().mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([{ _id: orderedId, name: 'Ann', email: 'a@x.com', phone: '1' }]) }) }) });
      r.userModel.find = find;

      const res: any = await build(r).searchStoreCustomers('seller1', 's1', 'ann');

      const filter = find.mock.calls[0][0];
      expect(filter._id.$in.sort()).toEqual([orderedId, posId].sort()); // never an unscoped find
      expect(res.data).toEqual([{ id: orderedId, name: 'Ann', email: 'a@x.com', phone: '1' }]);
    });

    it('returns nothing (and runs no user query) when the store has no customers', async () => {
      const r = makeRepos();
      const res: any = await build(r).searchStoreCustomers('seller1', 's1', 'ann');
      expect(res.data).toEqual([]);
    });

    it('ignores one-character queries', async () => {
      const r = makeRepos();
      const res: any = await build(r).searchStoreCustomers('seller1', 's1', 'a');
      expect(res.data).toEqual([]);
      expect(r.orderModel.aggregate).not.toHaveBeenCalled();
    });
  });
});
