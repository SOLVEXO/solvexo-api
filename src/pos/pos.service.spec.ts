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
