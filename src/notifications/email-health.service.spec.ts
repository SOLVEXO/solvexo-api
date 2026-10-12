// @ts-nocheck
/* eslint-disable */
jest.mock('@/database/databaseservice', () => ({ DatabaseService: class {} }));
jest.mock('./notifications.service', () => ({ NotificationsService: class {} }));
process.env.SMTP_USER = 'sender@test.dev';
process.env.SMTP_PASSWORD = 'secret-password';
process.env.SMTP_HOST = 'smtp.test.dev';
process.env.SMTP_PORT = '587';

import { EmailHealthService } from './email-health.service';
import { emailEvents } from '@/otp/services/email.service';

function leanQuery(value) {
  const q = { select: () => q, sort: () => q, limit: () => q, lean: () => Promise.resolve(value) };
  return q;
}

function make(rows = []) {
  const updateOne = jest.fn(() => Promise.resolve({}));
  const db = {
    repositories: {
      emailDailyStatModel: { updateOne, find: jest.fn(() => leanQuery(rows)) },
      adminModel: { findById: () => leanQuery({ email: 'admin@solvexo.test' }) },
    },
  };
  const notifications = { notifyAdmins: jest.fn(() => Promise.resolve(2)) };
  const email = { testConnection: jest.fn(() => Promise.resolve(true)), sendMail: jest.fn(() => Promise.resolve(true)) };
  const svc = new EmailHealthService(db, notifications, email);
  return { svc, updateOne, notifications, email };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('EmailHealthService', () => {
  beforeEach(() => emailEvents.removeAllListeners('result'));

  it('counts sent and failed emails per day', async () => {
    const { svc, updateOne } = make();
    svc.onModuleInit();
    emailEvents.emit('result', { ok: true });
    emailEvents.emit('result', { ok: false, error: 'Invalid login' });
    await flush();
    const today = new Date().toISOString().slice(0, 10);
    expect(updateOne.mock.calls[0]).toEqual([{ date: today }, { $inc: { sent: 1 } }, { upsert: true }]);
    expect(updateOne.mock.calls[1][1].$inc).toEqual({ failed: 1 });
    expect(updateOne.mock.calls[1][1].$set.lastError).toBe('Invalid login');
  });

  it('alerts the admins once after 5 failures in a row, not on every failure', async () => {
    const { svc, notifications } = make();
    svc.onModuleInit();
    for (let i = 0; i < 4; i++) emailEvents.emit('result', { ok: false, error: 'boom' });
    await flush();
    expect(notifications.notifyAdmins).not.toHaveBeenCalled();
    emailEvents.emit('result', { ok: false, error: 'boom' });
    await flush();
    expect(notifications.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifications.notifyAdmins.mock.calls[0][0]).toMatchObject({ type: 'admin_email_failure', data: { link: '/admin/settings?tab=email' } });
    for (let i = 0; i < 10; i++) emailEvents.emit('result', { ok: false, error: 'boom' });
    await flush();
    expect(notifications.notifyAdmins).toHaveBeenCalledTimes(1); // throttled to once an hour
  });

  it('a success resets the failure streak', async () => {
    const { svc, notifications } = make();
    svc.onModuleInit();
    for (let i = 0; i < 4; i++) emailEvents.emit('result', { ok: false });
    emailEvents.emit('result', { ok: true });
    for (let i = 0; i < 4; i++) emailEvents.emit('result', { ok: false });
    await flush();
    expect(notifications.notifyAdmins).not.toHaveBeenCalled();
  });

  it('getHealth returns 14 days, the SMTP settings and never the password', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { svc } = make([{ date: today, sent: 7, failed: 2, lastError: 'Invalid login', lastErrorAt: new Date() }]);
    const res = await svc.getHealth();
    expect(res.data.days).toHaveLength(14);
    expect(res.data.days[13]).toEqual({ date: today, sent: 7, failed: 2 });
    expect(res.data.totals).toEqual({ sent: 7, failed: 2 });
    expect(res.data.configured).toBe(true);
    expect(res.data.host).toBe('smtp.test.dev');
    expect(res.data.lastError).toBe('Invalid login');
    expect(JSON.stringify(res)).not.toContain('secret-password');
  });

  it('sendTest reports a bad SMTP login without sending, and a good one after sending', async () => {
    const a = make();
    a.email.testConnection.mockResolvedValueOnce(false);
    const bad = await a.svc.sendTest('admin1');
    expect(bad.success).toBe(false);
    expect(a.email.sendMail).not.toHaveBeenCalled();

    const b = make();
    const good = await b.svc.sendTest('admin1');
    expect(good).toEqual({ success: true, message: 'Test email sent to admin@solvexo.test.' });
    expect(b.email.sendMail.mock.calls[0][0]).toBe('admin@solvexo.test');
  });
});
