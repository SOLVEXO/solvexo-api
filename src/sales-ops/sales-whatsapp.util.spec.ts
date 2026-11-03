/* eslint-disable prettier/prettier */
import {
  nextStatus,
  parseWebhook,
  toWaId,
  windowOpen,
} from './sales-whatsapp.util';

const payload = (phoneNumberId: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: phoneNumberId },
            ...value,
          },
        },
      ],
    },
  ],
});

describe('WhatsApp webhook parsing', () => {
  it('reads messages of every type with the sender name, only for our number', () => {
    const p = payload('111', {
      contacts: [{ wa_id: '923001112223', profile: { name: 'Sara' } }],
      messages: [
        {
          id: 'wamid.1',
          from: '923001112223',
          timestamp: '1798700000',
          type: 'text',
          text: { body: 'Price kya hai?' },
        },
        {
          id: 'wamid.2',
          from: '923001112223',
          timestamp: '1798700001',
          type: 'image',
          image: { caption: 'my shop' },
        },
        {
          id: 'wamid.3',
          from: '923001112223',
          timestamp: '1798700002',
          type: 'audio',
          audio: {},
        },
        {
          id: 'wamid.4',
          from: 'not-a-number',
          type: 'text',
          text: { body: 'x' },
        },
      ],
    });
    const r = parseWebhook(p, '111');
    expect(r.messages.map((m) => [m.waMessageId, m.name, m.text])).toEqual([
      ['wamid.1', 'Sara', 'Price kya hai?'],
      ['wamid.2', 'Sara', '[Image] my shop'],
      ['wamid.3', 'Sara', '[Voice message]'],
    ]);
    expect(r.messages[0].at.toISOString()).toBe(
      new Date(1798700000 * 1000).toISOString(),
    );
    expect(parseWebhook(p, '222').messages).toEqual([]);
  });

  it('reads delivery statuses and errors', () => {
    const r = parseWebhook(
      payload('111', {
        statuses: [
          {
            id: 'wamid.9',
            status: 'read',
            timestamp: '1798700000',
            recipient_id: '92300',
          },
          {
            id: 'wamid.8',
            status: 'failed',
            errors: [
              {
                code: 131047,
                title: 'Re-engagement message',
                error_data: { details: 'More than 24 hours have passed' },
              },
            ],
          },
          { id: 'wamid.7', status: 'weird' },
        ],
      }),
      '111',
    );
    expect(r.statuses.map((s) => [s.waMessageId, s.status, s.error])).toEqual([
      ['wamid.9', 'read', null],
      [
        'wamid.8',
        'failed',
        'Re-engagement message: More than 24 hours have passed',
      ],
    ]);
  });

  it('knows the 24-hour window, formats Pakistani numbers, and only moves status forward', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(windowOpen('2026-11-01T12:30:00Z', now)).toBe(true);
    expect(windowOpen('2026-11-01T11:59:00Z', now)).toBe(false);
    expect(windowOpen(null, now)).toBe(false);
    expect(toWaId('0300 111-2223')).toBe('923001112223');
    expect(toWaId('+92 300 1112223')).toBe('923001112223');
    expect(toWaId('0044 7700 900123')).toBe('447700900123');
    expect(toWaId('123')).toBeNull();
    expect([
      nextStatus('read', 'delivered'),
      nextStatus('sent', 'read'),
      nextStatus('read', 'failed'),
      nextStatus('failed', 'read'),
    ]).toEqual(['read', 'read', 'failed', 'failed']);
  });
});
