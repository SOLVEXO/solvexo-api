/* eslint-disable prettier/prettier */
import { buildWhatsAppBodyParams, normalizeWhatsAppRecipient, resolveWhatsAppEventSettings } from './whatsapp-events';

describe('whatsapp-events', () => {
  it('defaults: shipped/delivered stay on, the new events are off', () => {
    expect(resolveWhatsAppEventSettings({}, 'order_shipped').enabled).toBe(true);
    expect(resolveWhatsAppEventSettings(undefined, 'order_confirmed').enabled).toBe(false);
    expect(resolveWhatsAppEventSettings({}, 'order_cancelled').enabled).toBe(false);
    expect(resolveWhatsAppEventSettings({}, 'order_refunded').enabled).toBe(false);
  });

  it('stored overrides win; garbage is ignored', () => {
    const s = resolveWhatsAppEventSettings(
      { notifications: { order_confirmed: { enabled: true, templateName: 'my_tpl', params: ['order_number', 'bogus', 'total'] } } },
      'order_confirmed',
    );
    expect(s).toMatchObject({ enabled: true, templateName: 'my_tpl', languageCode: 'en_US', params: ['order_number', 'total'] });
    expect(resolveWhatsAppEventSettings({ notifications: { order_shipped: 'x' } }, 'order_shipped').enabled).toBe(true);
  });

  it('builds ordered body params and never sends an empty parameter', () => {
    expect(buildWhatsAppBodyParams(['order_number', 'carrier', 'total'], { order_number: 'A1', total: 5 })).toEqual(['A1', '-', '5']);
  });

  it('normalizes recipients to digits', () => {
    expect(normalizeWhatsAppRecipient('+92 300-1234567')).toBe('923001234567');
  });
});
