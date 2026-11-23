/* eslint-disable prettier/prettier */
import { escapeEmailText, notificationEmailShell, solvexoEmail } from './notification-email.template';
import { platformReplyTo } from '../../otp/services/email.service';

describe('Solvexo-branded platform email', () => {
  it('has the Solvexo wordmark, escapes the title, and puts the given note in the footer', () => {
    const html = solvexoEmail('Hi <b>there</b>', '<p>Body</p>', { cta: { label: 'Open', url: 'https://x.test/a' }, note: 'Partner note' });
    expect(html).toContain('<div class="wordmark"><span>Solvexo</span></div>');
    expect(html).toContain('<h1>Hi &lt;b&gt;there&lt;/b&gt;</h1>');
    expect(html).toContain('<a class="cta" href="https://x.test/a">Open</a>');
    expect(html).toContain('<p>Partner note</p>');
    expect(html).not.toContain('activity on your Solvexo account');
  });

  it('keeps the account-activity footer by default and can drop the note entirely', () => {
    expect(notificationEmailShell('T', '')).toContain('activity on your Solvexo account');
    const bare = solvexoEmail('T', '', { note: null });
    expect(bare).not.toContain('activity on your');
    expect(bare).toContain('All rights reserved.');
  });

  it('a store-branded mail shows the store, not Solvexo', () => {
    const html = notificationEmailShell('Code', '<div class="code">123456</div>', undefined, { name: 'Ali & Sons', hideReceivingNotice: true });
    expect(html).toContain('<span>Ali &amp; Sons</span>');
    expect(html).not.toContain('<span>Solvexo</span>');
  });

  it('escapes text', () => {
    expect(escapeEmailText(`<script>"x" & y`)).toBe('&lt;script&gt;&quot;x&quot; &amp; y');
  });
});

describe('platform reply-to', () => {
  it('uses SMTP_REPLY_TO only when it is an address', () => {
    expect(platformReplyTo({ SMTP_REPLY_TO: ' support@solvexo.io ' } as any)).toBe('support@solvexo.io');
    expect(platformReplyTo({ SMTP_REPLY_TO: 'not an address' } as any)).toBeNull();
    expect(platformReplyTo({} as any)).toBeNull();
  });
});
