/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { validateBlockSettings, validateBlocks, FOOTER_ALLOWED_BLOCK_TYPES } from './section-settings.validator';

const ok = (type: string, settings: Record<string, any>) => expect(() => validateBlockSettings(type, settings)).not.toThrow();
const bad = (type: string, settings: Record<string, any>, msg?: RegExp) => {
  expect(() => validateBlockSettings(type, settings)).toThrow(BadRequestException);
  if (msg) expect(() => validateBlockSettings(type, settings)).toThrow(msg);
};

describe('footer blocks added in Batch 2', () => {
  it('footer_text needs text and stays short', () => {
    ok('footer_text', { text: 'Handmade in Lahore.' });
    bad('footer_text', { text: '' });
    bad('footer_text', { text: 'x'.repeat(601) });
  });

  it('footer_contact needs at least one real detail and a valid email', () => {
    ok('footer_contact', { heading: 'Contact', email: 'hello@shop.com' });
    ok('footer_contact', { phone: '+92 300 1234567', hours: 'Mon-Sat 10-8' });
    bad('footer_contact', { heading: 'Contact', email: '', phone: '  ' }, /at least one contact detail/);
    bad('footer_contact', { email: 'not-an-email' }, /email/);
    bad('footer_contact', { address: 'x'.repeat(241) });
    bad('footer_contact', { phone: 12345 as any });
  });

  it('footer_payment_icons only accepts the known badges, at most 12', () => {
    ok('footer_payment_icons', { icons: ['visa', 'jazzcash', 'cod'] });
    ok('footer_payment_icons', { icons: [] });
    bad('footer_payment_icons', { icons: ['visa', 'bitcoin'] });
    bad('footer_payment_icons', { icons: 'visa' as any });
    bad('footer_payment_icons', { icons: Array(13).fill('visa') });
  });

  it('are accepted in a footer block list and the old ones still are', () => {
    expect(FOOTER_ALLOWED_BLOCK_TYPES).toEqual(expect.arrayContaining(['footer_column', 'social_link', 'copyright_text', 'footer_text', 'footer_contact', 'footer_payment_icons']));
    expect(() => validateBlocks([
      { type: 'copyright_text', settings: { text: '© {year} Shop' } },
      { type: 'footer_text', settings: { text: 'About us' } },
    ], FOOTER_ALLOWED_BLOCK_TYPES, 20)).not.toThrow();
  });
});

describe('navigation link types added in Batch 2', () => {
  const link = (extra: Record<string, any>) => ({ label: 'Link', ...extra });

  it('cart and account links need nothing else', () => {
    ok('nav_link', link({ linkType: 'cart' }));
    ok('nav_link', link({ linkType: 'account' }));
  });

  it('email and phone links keep their value in url and must be well formed', () => {
    ok('nav_link', link({ linkType: 'email', url: 'hi@shop.com' }));
    ok('nav_link', link({ linkType: 'phone', url: '+92 300-123 4567' }));
    bad('nav_link', link({ linkType: 'email' }));
    bad('nav_link', link({ linkType: 'email', url: 'javascript:alert(1)' }), /valid email/);
    bad('nav_link', link({ linkType: 'phone', url: 'call me' }), /valid phone/);
  });

  it('newTab must be a boolean', () => {
    ok('nav_link', link({ linkType: 'external', url: 'https://example.com', newTab: true }));
    bad('nav_link', link({ linkType: 'external', url: 'https://example.com', newTab: 'yes' }), /newTab/);
  });

  it('applies the same rules to nested children', () => {
    ok('nav_link', link({ linkType: 'home', children: [{ id: 'c1', label: 'Mail us', linkType: 'email', url: 'a@b.co', newTab: false }] }));
    bad('nav_link', link({ linkType: 'home', children: [{ id: 'c1', label: 'Mail us', linkType: 'email', url: 'nope' }] }), /children\[\]\.url/);
  });

  it('keeps the existing link types working', () => {
    ok('nav_link', link({ linkType: 'page', pageSlug: 'about' }));
    bad('nav_link', link({ linkType: 'page' }));
    bad('nav_link', link({ linkType: 'teleport' }));
  });
});
