import { NotFoundException } from '@nestjs/common';
import { PurchaseOrdersService } from './purchase-orders.service';

// listSuppliers / getSupplierDetail against in-memory stand-ins for the models.

const chain = (rows: any[]) => {
  const q: any = { sort: () => q, limit: () => q, select: () => q, lean: async () => rows, then: undefined };
  return q;
};

function makeService(data: { suppliers: any[]; pos?: any[]; returns?: any[]; products?: any[]; grouped?: any[] }) {
  const repos = {
    storeModel: { findOne: async () => ({ _id: 's1' }) },
    supplierModel: {
      find: () => chain(data.suppliers),
      findOne: (q: any) => ({ lean: async () => data.suppliers.find(s => String(s._id) === String(q._id)) ?? null }),
    },
    purchaseOrderModel: { aggregate: async () => data.grouped ?? [], find: () => chain(data.pos ?? []) },
    supplierReturnModel: { find: () => chain(data.returns ?? []) },
    productModel: { find: () => chain(data.products ?? []) },
  };
  const svc: any = Object.create(PurchaseOrdersService.prototype);
  svc.databaseService = { repositories: repos };
  return svc as PurchaseOrdersService;
}

describe('listSuppliers', () => {
  it('attaches order stats and gives zeros to a supplier with no orders', async () => {
    const svc = makeService({
      suppliers: [{ _id: 'a', name: 'Ali Traders' }, { _id: 'b', name: 'Hassan Textile' }],
      grouped: [{ _id: 'a', poCount: 3, openPoCount: 1, spent: 4500, lastOrderAt: '2026-10-20T00:00:00Z' }],
    });
    const list: any[] = await svc.listSuppliers('s1', 'u1');
    expect(list[0].stats.poCount).toBe(3);
    expect(list[0].stats.openPoCount).toBe(1);
    expect(list[0].stats.spent).toBe(4500);
    expect(list[1].stats).toEqual({ poCount: 0, openPoCount: 0, spent: 0, lastOrderAt: null });
  });
});

describe('getSupplierDetail', () => {
  const po = (n: number, status: string, items: any[]) => ({ _id: `po${n}`, poNumber: `PO-${n}`, status, total: 100 * n, currency: 'PKR', createdAt: `2026-10-0${n}T00:00:00Z`, orderedAt: `2026-10-0${n}T00:00:00Z`, items });
  const item = (variantId: string, quantity: number, unitCost: number) => ({ productId: 'p1', variantId, name: 'Smart Ring', sku: `SKU-${variantId}`, options: [{ name: 'Color', value: 'Black' }], quantity, unitCost });

  it('rolls products up across orders, skips drafts and cancelled orders, keeps the newest cost', async () => {
    const svc = makeService({
      suppliers: [{ _id: 'a', name: 'Ali Traders' }],
      // newest first, as the query sorts them
      pos: [po(3, 'received', [item('v1', 5, 30)]), po(2, 'draft', [item('v1', 99, 1)]), po(1, 'received', [item('v1', 10, 20), item('v2', 4, 50)])],
      products: [{ _id: 'p9', name: 'Preferred Item' }],
    });
    const d: any = await svc.getSupplierDetail('s1', 'u1', 'a');
    const v1 = d.products.find((p: any) => p.variantId === 'v1');
    expect(v1.quantity).toBe(15);
    expect(v1.lastUnitCost).toBe(30);
    expect(d.products.length).toBe(2);
    expect(d.recentPurchaseOrders.length).toBe(3);
    expect(d.preferredProducts).toEqual([{ _id: 'p9', name: 'Preferred Item' }]);
  });

  it('is a 404 for a supplier that is not in this store', async () => {
    const svc = makeService({ suppliers: [{ _id: 'a', name: 'Ali Traders' }] });
    let err: unknown = null;
    try { await svc.getSupplierDetail('s1', 'u1', 'zzz'); } catch (e) { err = e; }
    expect(err instanceof NotFoundException).toBe(true);
  });
});
