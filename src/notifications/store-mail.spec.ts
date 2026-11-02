import { BadRequestException } from '@nestjs/common';
import { EmailService } from '../otp/services/email.service';
import { isPrivateIp, resolveSafeSmtpTarget, UnsafeSmtpTargetError } from './smtp-host-guard.util';
import { StoreMailService } from './store-mail.service';

describe('SMTP host guard', () => {
  it('treats private, loopback, link-local and metadata addresses as private', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '74.125.24.108', '2607:f8b0:4004:c08::6d']) expect(isPrivateIp(ip)).toBe(false);
  });

  it('refuses private hosts, bad names and non-mail ports; accepts a public address', async () => {
    const refused = async (host: string, port: number) => { try { await resolveSafeSmtpTarget(host, port); return false; } catch (e) { return e instanceof UnsafeSmtpTargetError; } };
    expect(await refused('127.0.0.1', 587)).toBe(true);
    expect(await refused('10.0.0.8', 25)).toBe(true);
    expect(await refused('localhost', 587)).toBe(true);
    expect(await refused('http://evil.example', 587)).toBe(true);
    expect(await refused('8.8.8.8', 22)).toBe(true);
    expect(await refused('8.8.8.8', 6379)).toBe(true);
    const ok = await resolveSafeSmtpTarget('8.8.8.8', 587);
    expect(ok.ip).toBe('8.8.8.8');
  });
});

describe('EmailService with a store SMTP', () => {
  const make = (hook: any) => {
    const svc = new EmailService();
    const calls = { platform: 0 };
    (svc as any).transporter = { sendMail: async () => { calls.platform++; return { messageId: 'p' }; } };
    EmailService.storeMail = hook;
    return { svc, calls };
  };

  it('sends through the store server and skips the platform one', async () => {
    const reports: boolean[] = [];
    let storeSent = 0;
    const { svc, calls } = make({ resolve: async () => ({ transporter: { sendMail: async () => { storeSent++; } }, from: 'info@shop.com' }), report: async (_s: string, ok: boolean) => { reports.push(ok); } });
    expect(await svc.sendMail('a@b.com', 's', '<p>x</p>', null, undefined, undefined, 'Shop', 'st1')).toBe(true);
    expect(storeSent).toBe(1);
    expect(calls.platform).toBe(0);
    expect(reports).toEqual([true]);
  });

  it('falls back to the platform sender when the store server fails, and reports the failure', async () => {
    const reports: boolean[] = [];
    const { svc, calls } = make({ resolve: async () => ({ transporter: { sendMail: async () => { throw new Error('535 bad password'); } }, from: 'info@shop.com' }), report: async (_s: string, ok: boolean) => { reports.push(ok); } });
    expect(await svc.sendMail('a@b.com', 's', '<p>x</p>', null, undefined, undefined, 'Shop', 'st1')).toBe(true);
    expect(calls.platform).toBe(1);
    expect(reports).toEqual([false]);
  });

  it('uses the platform sender for a store with no SMTP and for mails with no store', async () => {
    const { svc, calls } = make({ resolve: async () => null, report: async () => undefined });
    await svc.sendMail('a@b.com', 's', '<p>x</p>', null, undefined, undefined, 'Shop', 'st1');
    await svc.sendMail('a@b.com', 's', '<p>x</p>');
    expect(calls.platform).toBe(2);
  });
});

describe('StoreMailService settings', () => {
  const service = (smtp: any) => {
    const store = { findOne: () => ({ lean: async () => ({ _id: 's1' }) }) };
    const saved: any[] = [];
    const settings = {
      findOne: () => ({ select: () => ({ lean: async () => ({ smtp }) }) }),
      updateOne: async (_f: any, u: any) => { saved.push(u); },
    };
    const repos: any = { storeModel: { findById: (_id: string) => { const doc: any = Promise.resolve({ _id, sellerId: 'u1', isDelete: false, name: 'Shop' }); doc.select = () => ({ lean: async () => ({ name: 'Shop' }) }); return doc; } }, storeNotificationSettingsModel: settings };
    return { svc: new StoreMailService({ repositories: repos } as any, { notify: async () => undefined } as any), saved, store };
  };

  it('never returns the password', async () => {
    const { svc } = service({ enabled: true, host: 'smtp.example.com', port: 587, user: 'me', fromEmail: 'me@example.com', passwordEnc: 'iv:tag:secret', verifiedAt: new Date(), consecutiveFailures: 0 });
    const view: any = await svc.getView('u1', 's1');
    expect(view.data.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain('iv:tag:secret');
    expect(view.data.mode).toBe('own');
  });

  it('rejects a private host before anything is saved', async () => {
    const { svc, saved } = service(null);
    let err: unknown = null;
    try { await svc.save('u1', 's1', { host: '10.0.0.5', port: 587, user: 'me', password: 'pw', fromEmail: 'me@example.com' }, 'seller@example.com'); } catch (e) { err = e; }
    expect(err instanceof BadRequestException).toBe(true);
    expect(saved.length).toBe(0);
  });

  it('needs a password the first time', async () => {
    const { svc } = service(null);
    let msg = '';
    try { await svc.save('u1', 's1', { host: 'smtp.gmail.com', port: 587, user: 'me', fromEmail: 'me@example.com' }, 'seller@example.com'); } catch (e: any) { msg = e.message; }
    expect(msg).toContain('password');
  });
});
