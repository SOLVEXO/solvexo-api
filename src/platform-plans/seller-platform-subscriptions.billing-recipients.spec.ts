/* eslint-disable prettier/prettier */
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';

const leanOf = (v: any) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) }) });

function build(repos: Record<string, any>) {
  const db = { repositories: repos } as any;
  return new SellerPlatformSubscriptionsService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('SellerPlatformSubscriptionsService — billing email recipients', () => {
  it('owner first, plus active staff of the store whose role has billing view, de-duplicated case-insensitively', async () => {
    const roleModel = { find: jest.fn().mockReturnValue(leanOf([{ _id: 'r1' }])) };
    const staffMemberModel = { find: jest.fn().mockReturnValue(leanOf([{ email: 'Owner@Shop.com' }, { email: 'acct@shop.com' }])) };
    const svc = build({ roleModel, staffMemberModel });

    const out = await svc.resolveBillingRecipients('store-1', 'owner@shop.com');

    expect(out).toEqual(['owner@shop.com', 'acct@shop.com']);
    expect(roleModel.find).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'store-1', permissions: { $in: ['settings.billing.view', 'settings.billing.manage'] } }));
    expect(staffMemberModel.find).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'store-1', status: 'active', roleId: { $in: ['r1'] } }));
  });

  it('no matching roles -> owner only, staff never queried', async () => {
    const staffMemberModel = { find: jest.fn() };
    const svc = build({ roleModel: { find: jest.fn().mockReturnValue(leanOf([])) }, staffMemberModel });
    expect(await svc.resolveBillingRecipients('s', 'o@x.com')).toEqual(['o@x.com']);
    expect(staffMemberModel.find).not.toHaveBeenCalled();
  });

  it('a DB failure never breaks the billing flow — falls back to the owner', async () => {
    const svc = build({ roleModel: { find: jest.fn().mockImplementation(() => { throw new Error('boom'); }) }, staffMemberModel: {} });
    expect(await svc.resolveBillingRecipients('s', 'o@x.com')).toEqual(['o@x.com']);
  });
});

describe('SellerPlatformSubscriptionsService — invoice pagination', () => {
  it('applies page/limit, caps limit at 50, and returns total/pages', async () => {
    const chain: any = { sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([{ _id: 'i1' }]) };
    const invoiceModel = { find: jest.fn().mockReturnValue(chain), countDocuments: jest.fn().mockResolvedValue(25) };
    const storeModel = { findById: jest.fn().mockReturnValue(leanOf({ _id: 's', sellerId: 'seller' })) };
    const svc: any = build({ platformPlanInvoiceModel: invoiceModel, storeModel });
    svc.verifyStoreOwnership = jest.fn().mockResolvedValue(undefined);

    const res = await svc.listInvoices('seller', 's', { page: 3, limit: 10 });
    expect(chain.skip).toHaveBeenCalledWith(20);
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(res.data).toEqual(expect.objectContaining({ total: 25, page: 3, limit: 10, pages: 3 }));

    await svc.listInvoices('seller', 's', { page: 1, limit: 500 });
    expect(chain.limit).toHaveBeenLastCalledWith(50);
  });
});
