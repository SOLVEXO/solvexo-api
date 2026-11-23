/* eslint-disable */
// @ts-nocheck
const transports: any[] = [];
jest.mock('nodemailer', () => ({
  createTransport: jest.fn((opts) => {
    const t = { opts, sendMail: jest.fn(async () => ({ messageId: 'm' })), verify: jest.fn(async () => true) };
    transports.push(t);
    return t;
  }),
}));

import { EmailService, emailEvents, isBulkMail, marketingSmtpConfig } from './email.service';

const BULK = { 'List-Unsubscribe': '<https://api.solvexo.store/u/abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
const ENV = { ...process.env };

function make(env: Record<string, string | undefined>) {
  transports.length = 0;
  process.env = { ...ENV, SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'hello@solvexo.store', SMTP_PASSWORD: 'p', SMTP_FROM: 'hello@solvexo.store', APP_NAME: 'Solvexo', DEV_OTP_LOG: undefined, ...env };
  const svc = new EmailService();
  return { svc, platform: transports[0], marketing: transports[1] };
}

describe('EmailService marketing sender', () => {
  afterAll(() => { process.env = ENV; });
  beforeEach(() => emailEvents.removeAllListeners('result'));

  it('recognises bulk mail by its List-Unsubscribe header, in any letter case', () => {
    expect(isBulkMail(BULK)).toBe(true);
    expect(isBulkMail({ 'list-unsubscribe': '<x>' })).toBe(true);
    expect(isBulkMail({ 'X-Other': '1' })).toBe(false);
    expect(isBulkMail(undefined)).toBe(false);
  });

  it('is off until host, user and password are all set, and defaults the port and sender', () => {
    expect(marketingSmtpConfig({ MARKETING_SMTP_HOST: 'smtp-relay.brevo.com', MARKETING_SMTP_USER: 'u' })).toBeNull();
    expect(marketingSmtpConfig({ MARKETING_SMTP_HOST: 'smtp-relay.brevo.com', MARKETING_SMTP_USER: 'u', MARKETING_SMTP_PASSWORD: 'k', SMTP_FROM: 'hello@solvexo.store' }))
      .toEqual({ host: 'smtp-relay.brevo.com', port: 587, user: 'u', pass: 'k', from: 'hello@solvexo.store' });
  });

  it('sends bulk mail through the marketing sender and everything else through the platform sender', async () => {
    const { svc, platform, marketing } = make({ MARKETING_SMTP_HOST: 'smtp-relay.brevo.com', MARKETING_SMTP_PORT: '587', MARKETING_SMTP_USER: 'u', MARKETING_SMTP_PASSWORD: 'k', MARKETING_SMTP_FROM: 'news@mail.solvexo.store' });
    expect(marketing.opts).toMatchObject({ host: 'smtp-relay.brevo.com', port: 587, secure: false, requireTLS: true });
    const events: any[] = [];
    emailEvents.on('result', (e) => events.push(e));

    expect(await svc.sendMail('buyer@example.com', 'Eid sale', '<p>Hi</p>', 'shop@example.com', BULK, undefined, 'Zainab Collection')).toBe(true);
    expect(marketing.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"Zainab Collection" <news@mail.solvexo.store>', headers: BULK, replyTo: 'shop@example.com' }));
    expect(platform.sendMail).not.toHaveBeenCalled();

    expect(await svc.sendMail('owner@example.com', 'Your code', '<p>123456</p>')).toBe(true);
    expect(platform.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"Solvexo" <hello@solvexo.store>' }));
    expect(events.map((e) => e.channel)).toEqual(['marketing', 'transactional']);
  });

  it('never falls back to the platform sender when the marketing sender fails', async () => {
    const { svc, platform, marketing } = make({ MARKETING_SMTP_HOST: 'h', MARKETING_SMTP_USER: 'u', MARKETING_SMTP_PASSWORD: 'k' });
    marketing.sendMail.mockRejectedValueOnce(new Error('Daily quota exceeded'));
    const events: any[] = [];
    emailEvents.on('result', (e) => events.push(e));
    expect(await svc.sendMail('buyer@example.com', 'Sale', '<p>x</p>', null, BULK)).toBe(false);
    expect(platform.sendMail).not.toHaveBeenCalled();
    expect(events).toEqual([{ ok: false, channel: 'marketing', error: 'Daily quota exceeded' }]);
  });

  it('keeps bulk mail on the platform sender while no marketing sender is set', async () => {
    const { svc, platform, marketing } = make({ MARKETING_SMTP_HOST: undefined });
    expect(marketing).toBeUndefined();
    expect(svc.hasMarketingSender()).toBe(false);
    expect(await svc.sendMail('buyer@example.com', 'Sale', '<p>x</p>', null, BULK)).toBe(true);
    expect(platform.sendMail).toHaveBeenCalledTimes(1);
    expect(await svc.testConnection('marketing')).toBe(false);
  });

  it('uses implicit TLS on port 465', () => {
    const { marketing } = make({ MARKETING_SMTP_HOST: 'email-smtp.eu-west-1.amazonaws.com', MARKETING_SMTP_PORT: '465', MARKETING_SMTP_USER: 'u', MARKETING_SMTP_PASSWORD: 'k' });
    expect(marketing.opts).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });
});
