/* eslint-disable prettier/prettier */
import {
  checkMetaTemplate,
  templatesOf,
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

describe('WhatsApp templates Solvexo can send', () => {
  const body = (text: string) => ({ type: 'BODY', text });
  it('accepts a plain body, or one with {{1}} for the first name, with fixed buttons', () => {
    expect(checkMetaTemplate([body('Hello from Solvexo')])).toEqual({ ok: true, body: 'Hello from Solvexo', usesName: false });
    expect(checkMetaTemplate([{ type: 'HEADER', format: 'TEXT', text: 'Solvexo' }, body('Hi {{1}}, a quick follow-up'),
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Book a demo' }, { type: 'URL', url: 'https://www.solvexo.store/book-demo' }] }]))
      .toEqual({ ok: true, body: 'Hi {{1}}, a quick follow-up', usesName: true });
  });
  it('refuses what Solvexo cannot fill: more variables, named ones, header media or variables, button parameters', () => {
    expect(checkMetaTemplate([body('Hi {{1}}, your order {{2}}')])).toMatchObject({ ok: false, problem: expect.stringContaining('{{1}}, {{2}}') });
    expect(checkMetaTemplate([body('Hi {{first_name}}')])).toMatchObject({ ok: false });
    expect(checkMetaTemplate([{ type: 'HEADER', format: 'IMAGE' }, body('Hi')])).toMatchObject({ ok: false, problem: expect.stringContaining('image') });
    expect(checkMetaTemplate([{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, body('Hi')])).toMatchObject({ ok: false, problem: 'its header has a variable' });
    expect(checkMetaTemplate([body('Hi'), { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.pk/{{1}}' }] }])).toMatchObject({ ok: false });
    expect(checkMetaTemplate([body('Hi'), { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] }])).toMatchObject({ ok: false, problem: 'it has a copy code button' });
  });
  it('reads the list, or the single template saved before lists existed', () => {
    expect(templatesOf({})).toEqual([]);
    expect(templatesOf({ waTemplateName: 'sales_followup', waTemplateLang: 'ur', waTemplateUsesName: true }))
      .toEqual([{ key: 'sales_followup:ur', label: 'sales_followup', name: 'sales_followup', lang: 'ur', usesName: true, body: null }]);
    const list = [{ key: 'a:en', label: 'A', name: 'a', lang: 'en', usesName: false, body: 'x' }];
    expect(templatesOf({ waTemplates: list, waTemplateName: 'old' })).toBe(list);
  });
});
