import { ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { PosService } from './pos.service';

/**
 * Focused unit tests for the employee-JWT verification added to replace the
 * spoofable `actingEmployeeId` check on refund/void/cash-adjustment/discount.
 * These two methods (verifyEmployeeToken/requireManagerEmployee) don't touch
 * the database, so PosService is instantiated directly with stub
 * dependencies rather than mocking the full repository surface.
 */
describe('PosService — employee token verification', () => {
  const ORIGINAL_ENV = process.env;
  let service: PosService;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret' };
    service = new PosService({} as any, { log: jest.fn() } as any, {} as any);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function signEmployeeToken(
    overrides: Partial<{ employeeId: string; storeId: string; role: string; type: string }> = {},
  ) {
    return jwt.sign(
      { employeeId: 'emp1', storeId: 'store1', sellerId: 'seller1', role: 'manager', type: 'pos_employee', ...overrides },
      'test-secret',
      { expiresIn: '12h' },
    );
  }

  describe('verifyEmployeeToken', () => {
    it('returns null when no token is provided', () => {
      expect((service as any).verifyEmployeeToken(undefined, 'store1')).toBeNull();
    });

    it('returns null for a token signed with the wrong secret', () => {
      const forged = jwt.sign(
        { employeeId: 'emp1', storeId: 'store1', role: 'manager', type: 'pos_employee' },
        'wrong-secret',
      );
      expect((service as any).verifyEmployeeToken(forged, 'store1')).toBeNull();
    });

    it('returns null when the token was minted for a different store', () => {
      const token = signEmployeeToken({ storeId: 'store1' });
      expect((service as any).verifyEmployeeToken(token, 'store2')).toBeNull();
    });

    it('returns null for a token that is not a pos_employee token', () => {
      const token = jwt.sign(
        { employeeId: 'emp1', storeId: 'store1', role: 'manager', type: 'seller' },
        'test-secret',
      );
      expect((service as any).verifyEmployeeToken(token, 'store1')).toBeNull();
    });

    it('returns the employeeId and role for a valid token', () => {
      const token = signEmployeeToken({ role: 'cashier' });
      expect((service as any).verifyEmployeeToken(token, 'store1')).toEqual({ employeeId: 'emp1', role: 'cashier' });
    });
  });

  describe('requireManagerEmployee', () => {
    it('throws ForbiddenException when no token is provided', () => {
      expect(() => (service as any).requireManagerEmployee(undefined, 'store1', 'do the thing')).toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when the verified role is cashier, not manager', () => {
      const token = signEmployeeToken({ role: 'cashier' });
      expect(() => (service as any).requireManagerEmployee(token, 'store1', 'do the thing')).toThrow(
        ForbiddenException,
      );
    });

    it('returns the actor when the verified role is manager', () => {
      const token = signEmployeeToken({ role: 'manager' });
      expect((service as any).requireManagerEmployee(token, 'store1', 'do the thing')).toEqual({
        employeeId: 'emp1',
        role: 'manager',
      });
    });
  });
});

describe('PosService — pinLogin lockout and caller pinning', () => {
  const ORIGINAL_ENV = process.env;
  const bcrypt = require('bcrypt');

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret' };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function makeService(overrides: Record<string, any> = {}) {
    const employee: any = {
      _id: 'emp1',
      sellerId: 'seller1',
      role: 'cashier',
      status: 'active',
      pin: await bcrypt.hash('1234', 4),
      pinFailedAttempts: 0,
      pinLockedUntil: null,
      toObject() { return { ...this }; },
      ...overrides,
    };
    const employeeModel: any = {
      findOne: jest.fn(() => ({ select: async () => employee })),
      findOneAndUpdate: jest.fn(() => ({
        select: () => ({ lean: async () => { employee.pinFailedAttempts += 1; return employee; } }),
      })),
      updateOne: jest.fn(async (_q: any, u: any) => { Object.assign(employee, u.$set); }),
    };
    const repos: any = {
      employeeModel,
      storeModel: { findOne: jest.fn(async (q: any) => (q.sellerId === 'seller1' ? { _id: q._id } : null)) },
      registerSessionModel: { findOne: () => ({ lean: async () => null }) },
      posAuditLogModel: { create: jest.fn(async () => undefined) },
    };
    const service = new PosService({ repositories: repos } as any, { log: jest.fn() } as any, {} as any);
    return { service, employee, employeeModel };
  }

  const seller = { userId: 'seller1', role: 'seller' };
  const dto = (pin: string) => ({ storeId: 'store1', email: 'e@x.com', pin }) as any;

  it('locks the employee after 5 wrong PINs and then rejects even the right PIN', async () => {
    const { service, employee } = await makeService();
    for (let i = 0; i < 5; i++) {
      await expect(service.pinLogin(dto('0000'), seller)).rejects.toThrow('Invalid credentials');
    }
    expect(employee.pinLockedUntil).toBeInstanceOf(Date);
    await expect(service.pinLogin(dto('1234'), seller)).rejects.toThrow(/Too many failed PIN attempts/);
  });

  it('succeeds with the right PIN and clears the failure counter', async () => {
    const { service, employee } = await makeService({ pinFailedAttempts: 3 });
    const res = await service.pinLogin(dto('1234'), seller);
    expect(res.success).toBe(true);
    expect(employee.pinFailedAttempts).toBe(0);
  });

  it('allows login again once the lock has expired', async () => {
    const { service } = await makeService({ pinLockedUntil: new Date(Date.now() - 1000) });
    await expect(service.pinLogin(dto('1234'), seller)).resolves.toMatchObject({ success: true });
  });

  it('rejects a buyer/admin caller, a seller of another store, and staff of another store', async () => {
    const { service } = await makeService();
    await expect(service.pinLogin(dto('1234'), { userId: 'u', role: 'user' })).rejects.toThrow(ForbiddenException);
    await expect(service.pinLogin(dto('1234'), { userId: 'other', role: 'seller' })).rejects.toThrow(ForbiddenException);
    await expect(service.pinLogin(dto('1234'), { userId: 's', role: 'staff', storeId: 'store2' })).rejects.toThrow(ForbiddenException);
    await expect(service.pinLogin(dto('1234'), { userId: 's', role: 'staff', storeId: 'store1' })).resolves.toMatchObject({ success: true });
  });
});
