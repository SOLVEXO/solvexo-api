import { AuthService } from './auth.service';

/**
 * Covers the per-store buyer identity behavior: email uniqueness/lookup is
 * scoped to {storeId, email}, not email alone (see User.storeId's schema
 * comment and AuthService.emailScope). Uses an in-memory fake Mongoose
 * model — documents are live object references (not copies), so the
 * mutate-fields-then-`.save()` pattern used throughout auth.service.ts
 * (resendOtp/verifyOtp/forgotPassword/resetPassword) behaves the same way
 * a real Mongoose document would, without touching a real database.
 */
function makeFakeModel(seedDocs: any[] = []) {
  const docs: any[] = [...seedDocs];
  let nextId = docs.length + 1;

  function matches(doc: any, query: Record<string, unknown>) {
    return Object.entries(query).every(([key, value]) => {
      if (key === '_id') return String(doc._id) === String(value);
      const docValue = doc[key] ?? null;
      const queryValue = value ?? null;
      return docValue === queryValue;
    });
  }

  function FakeModel(this: any, data: any) {
    Object.assign(this, data);
    this._id = `id-${nextId++}`;
    this.save = jest.fn(async () => {
      if (!docs.includes(this)) docs.push(this);
      return this;
    });
  }

  (FakeModel as any).findOne = jest.fn((query: Record<string, unknown> = {}) => {
    const found = docs.find((d) => matches(d, query)) ?? null;
    return {
      // supports plain `await findOne(...)` (auth.service) and the
      // `.select().lean()` chain (assertValidStoreId's storeModel lookup).
      then: (resolve: any) => resolve(found),
      select: () => ({ lean: async () => found }),
    };
  });

  return { model: FakeModel as any, docs };
}

function makeService({ storeIds = ['storeA', 'storeB'] } = {}) {
  const { model: userModel, docs: userDocs } = makeFakeModel();
  const { model: storeModel } = makeFakeModel(storeIds.map((id) => ({ _id: id, isDelete: false })));

  const databaseService = {
    repositories: {
      userModel,
      sellerModel: makeFakeModel().model,
      adminModel: makeFakeModel().model,
      storeModel,
    },
  };

  const otpService = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const redisService = { set: jest.fn().mockResolvedValue(undefined), del: jest.fn() };
  const activityLogService = { log: jest.fn().mockResolvedValue(undefined) };
  const jwtService = { sign: jest.fn(() => 'signed-jwt') };

  const service = new AuthService(
    databaseService as any,
    otpService as any,
    redisService as any,
    activityLogService as any,
    jwtService as any,
  );

  return { service, userModel, userDocs };
}

describe('AuthService — per-store buyer identity', () => {
  describe('signup', () => {
    it('allows the same email to register on two different stores', async () => {
      const { service, userDocs } = makeService();

      await service.signup({
        name: 'A',
        role: 'user',
        email: 'same@example.com',
        password: 'password123',
        storeId: 'storeA',
      } as any);

      await service.signup({
        name: 'B',
        role: 'user',
        email: 'same@example.com',
        password: 'differentpass',
        storeId: 'storeB',
      } as any);

      const accounts = userDocs.filter((d) => d.email === 'same@example.com');
      expect(accounts).toHaveLength(2);
      expect(accounts.map((a) => a.storeId).sort()).toEqual(['storeA', 'storeB']);
      // separate password hashes — independent accounts, not one shared identity
      expect(accounts[0].password).not.toEqual(accounts[1].password);
    });

    it('still rejects a second registration with the same email on the same store', async () => {
      const { service } = makeService();

      await service.signup({
        name: 'A',
        role: 'user',
        email: 'dup@example.com',
        password: 'password123',
        storeId: 'storeA',
      } as any);

      await expect(
        service.signup({
          name: 'A2',
          role: 'user',
          email: 'dup@example.com',
          password: 'password456',
          storeId: 'storeA',
        } as any),
      ).rejects.toThrow('User already exists');
    });
  });

  describe('login', () => {
    it('logs into only the correct store account when the email exists on multiple stores', async () => {
      const { service, userModel } = makeService();

      await service.signup({
        name: 'A',
        role: 'user',
        email: 'shared@example.com',
        password: 'passwordA',
        storeId: 'storeA',
      } as any);
      await service.signup({
        name: 'B',
        role: 'user',
        email: 'shared@example.com',
        password: 'passwordB',
        storeId: 'storeB',
      } as any);

      const accountA = await userModel.findOne({ email: 'shared@example.com', storeId: 'storeA' });
      const accountB = await userModel.findOne({ email: 'shared@example.com', storeId: 'storeB' });
      accountA.isVerified = true;
      accountB.isVerified = true;

      const loginA = await service.login({
        email: 'shared@example.com',
        password: 'passwordA',
        role: 'user',
        storeId: 'storeA',
      } as any);
      expect(loginA.data.user.id).toEqual(accountA._id);

      // correct password for A, but scoped to B — must not match A's account
      await expect(
        service.login({
          email: 'shared@example.com',
          password: 'passwordA',
          role: 'user',
          storeId: 'storeB',
        } as any),
      ).rejects.toThrow('Invalid email or password');

      const loginB = await service.login({
        email: 'shared@example.com',
        password: 'passwordB',
        role: 'user',
        storeId: 'storeB',
      } as any);
      expect(loginB.data.user.id).toEqual(accountB._id);
      expect(loginB.data.user.id).not.toEqual(loginA.data.user.id);
    });
  });

  describe('password reset', () => {
    it('resets only the targeted store account when the email exists on multiple stores', async () => {
      const { service, userModel } = makeService();

      await service.signup({
        name: 'A',
        role: 'user',
        email: 'reset@example.com',
        password: 'passwordA',
        storeId: 'storeA',
      } as any);
      await service.signup({
        name: 'B',
        role: 'user',
        email: 'reset@example.com',
        password: 'passwordB',
        storeId: 'storeB',
      } as any);

      const accountA = await userModel.findOne({ email: 'reset@example.com', storeId: 'storeA' });
      const accountB = await userModel.findOne({ email: 'reset@example.com', storeId: 'storeB' });
      const originalPasswordA = accountA.password;
      const originalPasswordB = accountB.password;

      await service.forgotPassword('reset@example.com', 'user', 'storeA');

      expect(accountA.otp).toBeTruthy();
      // storeB's account must be untouched by a storeA-scoped reset request
      expect(accountB.otp).toBeFalsy();

      await service.resetPassword(
        'reset@example.com',
        'user',
        accountA.otp,
        'brandNewPassword',
        'storeA',
      );

      expect(accountA.password).not.toEqual(originalPasswordA);
      // storeB's password must be unaffected by storeA's reset
      expect(accountB.password).toEqual(originalPasswordB);
    });
  });
});
