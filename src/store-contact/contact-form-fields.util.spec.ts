/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import {
  ContactFormField, legacyContactFields, resolveContactFields, validateContactAnswers, validateContactFieldDefs,
} from './contact-form-fields.util';

const base = (): ContactFormField[] => [
  { id: 'f-name', type: 'name', label: 'Your name', required: true },
  { id: 'f-mail', type: 'email', label: 'Email', required: true },
  { id: 'f-topic', type: 'dropdown', label: 'Topic', options: ['Order', 'Other'] },
  { id: 'f-news', type: 'checkbox', label: 'Interests', options: ['Sales', 'News'] },
  { id: 'f-msg', type: 'textarea', label: 'Message', required: true },
];

describe('contact form field definitions', () => {
  it('accepts a normal list', () => {
    expect(() => validateContactFieldDefs(base())).not.toThrow();
  });

  it('needs an Email or Phone field that is required (Shopify Forms rule)', () => {
    expect(() => validateContactFieldDefs([{ id: 'a1', type: 'text', label: 'Name', required: true }])).toThrow();
    expect(() => validateContactFieldDefs([{ id: 'a1', type: 'email', label: 'Email', required: false }])).toThrow();
    expect(() => validateContactFieldDefs([{ id: 'a1', type: 'phone', label: 'Phone', required: true }])).not.toThrow();
  });

  it('refuses more than 31 fields, duplicate ids, unknown types and empty labels', () => {
    const many = Array.from({ length: 32 }, (_, i) => ({ id: `id${i}`, type: 'text', label: `L${i}` }));
    expect(() => validateContactFieldDefs(many)).toThrow();
    expect(() => validateContactFieldDefs([...base(), { id: 'f-name', type: 'text', label: 'Again' }])).toThrow();
    expect(() => validateContactFieldDefs([...base(), { id: 'zz1', type: 'file', label: 'Upload' }])).toThrow();
    expect(() => validateContactFieldDefs([...base(), { id: 'zz2', type: 'text', label: '   ' }])).toThrow();
  });

  it('needs choices for dropdown and radio, and only those types may have them', () => {
    expect(() => validateContactFieldDefs([...base(), { id: 'zz3', type: 'radio', label: 'Pick' }])).toThrow();
    expect(() => validateContactFieldDefs([...base(), { id: 'zz4', type: 'text', label: 'Free', options: ['a'] }])).toThrow();
    expect(() => validateContactFieldDefs([...base(), { id: 'zz5', type: 'dropdown', label: 'Dup', options: ['a', 'a'] }])).toThrow();
  });

  it('rebuilds the old fixed form for a section that never had fields', () => {
    const f = legacyContactFields({ showPhone: false, nameLabel: 'Full name' });
    expect(f.map(x => x.id)).toEqual(['name', 'email', 'message']);
    expect(f[0].label).toBe('Full name');
    expect(legacyContactFields({}).map(x => x.id)).toEqual(['name', 'email', 'phone', 'message']);
    expect(resolveContactFields({ fields: base() })).toHaveLength(5);
    expect(resolveContactFields({})).toHaveLength(4);
  });
});

describe('contact form answers', () => {
  const ok = [
    { fieldId: 'f-name', value: '  Ayesha ' },
    { fieldId: 'f-mail', value: 'AYESHA@Example.com' },
    { fieldId: 'f-topic', value: 'Order' },
    { fieldId: 'f-news', value: ['Sales', 'News'] },
    { fieldId: 'f-msg', value: 'Hello there' },
  ];

  it('keeps clean answers in form order and derives the sender details', () => {
    const r = validateContactAnswers(base(), ok);
    expect(r.name).toBe('Ayesha');
    expect(r.email).toBe('ayesha@example.com');
    expect(r.message).toBe('Hello there');
    expect(r.clean.map(a => a.id)).toEqual(['f-name', 'f-mail', 'f-topic', 'f-news', 'f-msg']);
    expect(r.clean.find(a => a.id === 'f-news')?.value).toBe('Sales, News');
  });

  it('refuses a missing required field and a bad email', () => {
    expect(() => validateContactAnswers(base(), ok.filter(a => a.fieldId !== 'f-msg'))).toThrow();
    expect(() => validateContactAnswers(base(), ok.map(a => (a.fieldId === 'f-mail' ? { ...a, value: 'not-an-email' } : a)))).toThrow();
  });

  it('refuses a choice the seller never offered and ignores answers for unknown fields', () => {
    expect(() => validateContactAnswers(base(), ok.map(a => (a.fieldId === 'f-topic' ? { ...a, value: 'Hack' } : a)))).toThrow();
    expect(() => validateContactAnswers(base(), ok.map(a => (a.fieldId === 'f-news' ? { ...a, value: ['Nope'] } : a)))).toThrow();
    const r = validateContactAnswers(base(), [...ok, { fieldId: 'evil', value: 'x' }]);
    expect(r.clean.some(a => a.id === 'evil')).toBe(false);
  });

  it('checks number, date and phone formats', () => {
    const defs: ContactFormField[] = [
      { id: 'n1', type: 'number', label: 'Qty', required: true },
      { id: 'd1', type: 'date', label: 'Day' },
      { id: 'p1', type: 'phone', label: 'Phone', required: true },
    ];
    expect(() => validateContactAnswers(defs, [{ fieldId: 'n1', value: 'abc' }, { fieldId: 'p1', value: '+92 300 1234567' }])).toThrow();
    expect(() => validateContactAnswers(defs, [{ fieldId: 'n1', value: 4 }, { fieldId: 'd1', value: '2026-13-45' }, { fieldId: 'p1', value: '+92 300 1234567' }])).toThrow();
    expect(() => validateContactAnswers(defs, [{ fieldId: 'n1', value: '4' }, { fieldId: 'd1', value: '2026-11-12' }, { fieldId: 'p1', value: '12' }])).toThrow();
    const r = validateContactAnswers(defs, [{ fieldId: 'n1', value: '4' }, { fieldId: 'd1', value: '2026-11-12' }, { fieldId: 'p1', value: '+92 300 1234567' }]);
    expect(r.phone).toBe('+92 300 1234567');
  });

  it('works with the old fixed form ids', () => {
    const r = validateContactAnswers(legacyContactFields({}), [
      { fieldId: 'name', value: 'A' }, { fieldId: 'email', value: 'a@b.co' }, { fieldId: 'message', value: 'Hi' },
    ]);
    expect(r.name).toBe('A');
    expect(r.message).toBe('Hi');
  });

  it('a single tick box (no choices) is Yes or empty', () => {
    const defs: ContactFormField[] = [{ id: 'm1', type: 'email', label: 'Mail', required: true }, { id: 'c1', type: 'checkbox', label: 'I agree', required: true }];
    expect(() => validateContactAnswers(defs, [{ fieldId: 'm1', value: 'a@b.co' }])).toThrow();
    expect(validateContactAnswers(defs, [{ fieldId: 'm1', value: 'a@b.co' }, { fieldId: 'c1', value: 'true' }]).clean[1].value).toBe('Yes');
  });
});

describe('contact_form section settings (saved by the seller)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateSectionSettings } = require('../common/store-content/section-settings.validator');
  it('accepts a valid field list and an old section without one', () => {
    expect(() => validateSectionSettings('contact_form', { fields: base() })).not.toThrow();
    expect(() => validateSectionSettings('contact_form', { heading: 'Hi', showPhone: true })).not.toThrow();
  });
  it('refuses a field list that cannot reach the visitor or has a bad field', () => {
    expect(() => validateSectionSettings('contact_form', { fields: [{ id: 'a1', type: 'text', label: 'Name', required: true }] })).toThrow();
    expect(() => validateSectionSettings('contact_form', { fields: 'nope' })).toThrow();
  });
});
