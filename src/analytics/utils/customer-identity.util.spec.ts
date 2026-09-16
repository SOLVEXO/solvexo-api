/* eslint-disable prettier/prettier */
import { resolveCustomerIdentities } from './customer-identity.util';

// Phase 4 — this shared identity resolver had zero tests before this file.
// The one rule that matters most here: there is no guest-checkout path in
// this codebase (every checkout is behind JwtAuthGuard), so an unresolved
// userId must never be labeled "Guest" — only a real fallback (the name
// captured on the order itself) or the honest 'Deleted account'.

function buildUserModel(users: any[]) {
  return {
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(users),
      }),
    }),
  };
}

describe('resolveCustomerIdentities — Phase 4 real-identity resolution (never "Guest")', () => {
  it('resolves a live User document as the primary source', async () => {
    const userModel = buildUserModel([{ _id: 'u1', name: 'Amina Khan', email: 'amina@example.com' }]);
    const orderModel = { aggregate: jest.fn().mockResolvedValue([]) };

    const result = await resolveCustomerIdentities(userModel as any, orderModel as any, ['u1']);

    expect(result.get('u1')).toEqual({ name: 'Amina Khan', email: 'amina@example.com' });
    // No live user was missing, so the order-fallback aggregate should never even run.
    expect(orderModel.aggregate).not.toHaveBeenCalled();
  });

  it('falls back to the order\'s own shippingAddress.recipientName when the User document is gone', async () => {
    const userModel = buildUserModel([]); // account deleted
    const orderModel = {
      aggregate: jest.fn().mockResolvedValue([{ _id: 'u2', recipientName: 'Bilal Ahmed' }]),
    };

    const result = await resolveCustomerIdentities(userModel as any, orderModel as any, ['u2']);

    expect(result.get('u2')).toEqual({ name: 'Bilal Ahmed', email: '' });
  });

  it('falls back to "Deleted account" — never "Guest" — when neither the User nor a recipientName exists', async () => {
    const userModel = buildUserModel([]);
    const orderModel = { aggregate: jest.fn().mockResolvedValue([]) }; // no shippingAddress on any of their orders

    const result = await resolveCustomerIdentities(userModel as any, orderModel as any, ['u3']);

    expect(result.get('u3')?.name).toBe('Deleted account');
    expect(result.get('u3')?.name).not.toMatch(/guest/i);
  });

  it('only queries the fallback aggregate for the unresolved ids, not the whole batch', async () => {
    const userModel = buildUserModel([{ _id: 'u1', name: 'Amina Khan', email: 'amina@example.com' }]);
    const orderModel = { aggregate: jest.fn().mockResolvedValue([{ _id: 'u2', recipientName: 'Bilal Ahmed' }]) };

    await resolveCustomerIdentities(userModel as any, orderModel as any, ['u1', 'u2']);

    const pipeline = orderModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.userId.$in).toEqual(['u2']);
  });

  it('returns an empty map without querying anything for an empty id list', async () => {
    const userModel = buildUserModel([]);
    const orderModel = { aggregate: jest.fn() };

    const result = await resolveCustomerIdentities(userModel as any, orderModel as any, []);

    expect(result.size).toBe(0);
    expect(userModel.find).not.toHaveBeenCalled();
    expect(orderModel.aggregate).not.toHaveBeenCalled();
  });

  it('deduplicates repeated userIds into a single resolution', async () => {
    const userModel = buildUserModel([{ _id: 'u1', name: 'Amina Khan', email: 'amina@example.com' }]);
    const orderModel = { aggregate: jest.fn().mockResolvedValue([]) };

    await resolveCustomerIdentities(userModel as any, orderModel as any, ['u1', 'u1', 'u1']);

    const findFilter = userModel.find.mock.calls[0][0];
    expect(findFilter._id.$in).toEqual(['u1']);
  });
});
