/* eslint-disable prettier/prettier */
import { followUpTitle, parsePhotoDataUrl, stageAfterVisit, storeKey, visitSummary } from './field-visit.util';
import { VISIT_OPTIONS } from './field-visit.constants';

describe('field-visit.util', () => {
  it('moves a lead forward after a visit, closes it on "not interested", and never moves a later stage back', () => {
    expect(stageAfterVisit('new', 'warm')).toEqual({ stage: 'contacted', lost: false });
    expect(stageAfterVisit('lost', 'hot')).toEqual({ stage: 'contacted', lost: false });
    expect(stageAfterVisit('contacted', 'not_interested')).toEqual({ stage: 'lost', lost: true });
    expect(stageAfterVisit('demo', 'cold')).toBeNull();
    expect(stageAfterVisit('trial', 'not_interested')).toBeNull();
    expect(stageAfterVisit('won', 'hot')).toBeNull();
  });

  it('names the follow-up after the next step', () => {
    expect(followUpTitle('send_price', 'Glow')).toBe('Send price on WhatsApp — Glow');
    expect(followUpTitle('none', 'Glow')).toBeNull();
  });

  it('writes a readable timeline summary and leaves blanks out', () => {
    const s = visitSummary({
      storeName: 'Glow', unit: 'Shop 2', floor: 'ground', area: 'Liberty', category: 'other', categoryOther: 'Perfume',
      billing: 'software', billingSoftware: 'Moneypex', couriers: ['tcs', 'postex'], courierBooking: 'portal',
      whatsapp: '0300', waPermission: false, interest: 'warm', nextStep: 'revisit', nextStepAt: '2026-12-01T00:00:00.000Z',
    });
    expect(s.split('\n')).toEqual([
      'Shop: Glow — Shop 2 · Ground floor · Liberty',
      'Category: Perfume',
      'WhatsApp: 0300 (no permission to message)',
      'Courier: TCS, PostEx, booked by courier portal',
      'Billing / POS: Software: Moneypex',
      'Interest: Warm',
      'Next step: Revisit · 2026-12-01',
    ]);
  });

  it('matches shop names regardless of case and spacing', () => {
    expect(storeKey('  Zainab   COLLECTION ')).toBe('zainab collection');
  });

  it('reads only image data URLs', () => {
    expect(parsePhotoDataUrl('data:image/jpeg;base64,/9j/AA==')?.ext).toBe('jpg');
    expect(parsePhotoDataUrl('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull();
    expect(parsePhotoDataUrl('https://example.com/a.png')).toBeNull();
  });

  it('keeps option keys unique and labels non-empty', () => {
    for (const [group, opts] of Object.entries(VISIT_OPTIONS))
      for (const [k, label] of Object.entries(opts)) {
        expect(k).toMatch(/^[a-z0-9_]+$/);
        expect(String(label).length).toBeGreaterThan(0);
        expect(group).toBeTruthy();
      }
  });
});
