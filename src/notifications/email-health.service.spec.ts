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
    expect(res.data.days[13]).toEqual({ date: today, sent: 7, failed: 2, marketingSent: 0, marketingFailed: 0 });
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

  it('keeps marketing sends and failures apart from platform email, with their own alert', async () => {
    const { svc, updateOne, notifications } = make();
    svc.onModuleInit();
    emailEvents.emit('result', { ok: true, channel: 'marketing' });
    for (let i = 0; i < 5; i++) emailEvents.emit('result', { ok: false, channel: 'marketing', error: 'Quota exceeded' });
    await flush();
    expect(updateOne.mock.calls[0][1]).toEqual({ $inc: { marketingSent: 1 } });
    expect(updateOne.mock.calls[1][1].$inc).toEqual({ marketingFailed: 1 });
    expect(updateOne.mock.calls[1][1].$set.marketingLastError).toBe('Quota exceeded');
    expect(notifications.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifications.notifyAdmins.mock.calls[0][0].title).toBe('Marketing emails are failing to send');
    expect(notifications.notifyAdmins.mock.calls[0][0].body).toContain('Sign-up codes and order emails are not affected');
    const res = await svc.getHealth();
    expect(res.data.consecutiveFailures).toBe(0);
    expect(res.data.marketing.consecutiveFailures).toBe(5);
  });

  it('reports the marketing sender (never its password) and its 14-day totals', async () => {
    process.env.MARKETING_SMTP_HOST = 'smtp-relay.brevo.com';
    process.env.MARKETING_SMTP_USER = 'brevo-user';
    process.env.MARKETING_SMTP_PASSWORD = 'brevo-key';
    process.env.MARKETING_SMTP_FROM = 'news@mail.solvexo.store';
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { svc } = make([{ date: today, sent: 3, failed: 0, marketingSent: 120, marketingFailed: 4, marketingLastError: 'Rate limited', marketingLastErrorAt: new Date() }]);
      const res = await svc.getHealth();
      expect(res.data.marketing).toMatchObject({ configured: true, host: 'smtp-relay.brevo.com', port: 587, from: 'news@mail.solvexo.store', lastError: 'Rate limited', totals: { sent: 120, failed: 4 } });
      expect(JSON.stringify(res)).not.toContain('brevo-key');
    } finally {
      delete process.env.MARKETING_SMTP_HOST; delete process.env.MARKETING_SMTP_USER; delete process.env.MARKETING_SMTP_PASSWORD; delete process.env.MARKETING_SMTP_FROM;
    }
  });

  it('tests the marketing sender with a bulk-style mail, and says how to set it up when it is missing', async () => {
    const { svc, email } = make();
    email.hasMarketingSender = jest.fn(() => false);
    const missing = await svc.sendTest('admin-1', 'marketing');
    expect(missing.success).toBe(false);
    expect(missing.message).toContain('MARKETING_SMTP_HOST');
    email.hasMarketingSender = jest.fn(() => true);
    const ok = await svc.sendTest('admin-1', 'marketing');
    expect(ok.success).toBe(true);
    expect(email.testConnection).toHaveBeenLastCalledWith('marketing');
    expect(email.sendMail.mock.calls.at(-1)[4]).toHaveProperty('List-Unsubscribe');
  });
});
