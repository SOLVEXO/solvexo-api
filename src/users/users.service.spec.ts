import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';

describe('UsersService.changePassword — session revocation', () => {
  it('bumps tokenVersion and deletes the current Redis session', async () => {
    const user: any = {
      password: await bcrypt.hash('oldPassword1', 4),
      tokenVersion: 2,
      save: jest.fn(async () => undefined),
    };
    const db: any = { repositories: { userModel: { findById: jest.fn(async () => user) } } };
    const redis: any = { del: jest.fn(async () => undefined) };
    const service = new UsersService(db, redis);

    await service.changePassword('u1', 'user', { currentPassword: 'oldPassword1', newPassword: 'newPassword1' } as any, 'tok-123');

    expect(user.tokenVersion).toBe(3);
    expect(await bcrypt.compare('newPassword1', user.password)).toBe(true);
    expect(redis.del).toHaveBeenCalledWith('tok-123');
  });

  it('does not touch the session when the current password is wrong', async () => {
    const user: any = { password: await bcrypt.hash('oldPassword1', 4), tokenVersion: 0, save: jest.fn() };
    const db: any = { repositories: { userModel: { findById: jest.fn(async () => user) } } };
    const redis: any = { del: jest.fn() };
    const service = new UsersService(db, redis);

    await expect(
      service.changePassword('u1', 'user', { currentPassword: 'nope', newPassword: 'newPassword1' } as any, 'tok'),
    ).rejects.toThrow('Current password is incorrect');
    expect(user.tokenVersion).toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });
});
