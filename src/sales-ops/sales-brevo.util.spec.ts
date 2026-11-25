/* eslint-disable prettier/prettier */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-brevo-util';
import {
  brevoAttributes,
  brevoCsvFilename,
  brevoErrorText,
  buildBrevoCsv,
  consentView,
  csvCell,
  normalizeWhatsApp,
  parseBrevoWebhook,
  safeEqual,
  signConsentToken,
  splitName,
  verifyConsentToken,
} from './sales-brevo.util';

const LEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const DAY = 86_400_000;

describe('Brevo attributes', () => {
  it('splits the name into first word and the rest', () => {
    expect(splitName('Ayesha Khan Niazi')).toEqual({ first: 'Ayesha', last: 'Khan Niazi' });
    expect(splitName('  Bilal  ')).toEqual({ first: 'Bilal', last: '' });
    expect(splitName(null)).toEqual({ first: '', last: '' });
  });

  it('normalises Pakistani numbers to +92 and leaves others as given', () => {
    expect(normalizeWhatsApp('0300-1234567')).toBe('+923001234567');
    expect(normalizeWhatsApp('3001234567')).toBe('+923001234567');
    expect(normalizeWhatsApp('92 300 1234567')).toBe('+923001234567');
    expect(normalizeWhatsApp('0092 300 1234567')).toBe('+923001234567');
    expect(normalizeWhatsApp('+92 300 123 4567')).toBe('+923001234567');
    expect(normalizeWhatsApp('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizeWhatsApp('020 7946 0958')).toBe('020 7946 0958');
    expect(normalizeWhatsApp('')).toBeNull();
    expect(normalizeWhatsApp(null)).toBeNull();
  });

  it('maps a lead to Brevo attributes (WHATSAPP left out without a phone)', () => {
    expect(brevoAttributes({ name: 'Ayesha Khan', businessName: 'Khan Fabrics', city: 'Lahore', phone: '03001234567', stage: 'demo', source: 'website_form', utm: { campaign: 'eid-sale' } })).toEqual({
      FIRSTNAME: 'Ayesha', LASTNAME: 'Khan', COMPANY: 'Khan Fabrics', CITY: 'Lahore', WHATSAPP: '+923001234567', LEAD_STAGE: 'demo', LEAD_SOURCE: 'website_form', LEAD_CAMPAIGN: 'eid-sale',
    });
    const a = brevoAttributes({ name: 'Bilal', stage: 'new', source: 'manual' });
    expect(a).not.toHaveProperty('WHATSAPP');
    expect(a).toMatchObject({ LASTNAME: '', COMPANY: '', CITY: '', LEAD_CAMPAIGN: '' });
  });

  it('never shows the consent IP to the browser, and old leads read as none', () => {
    expect(consentView({ status: 'granted', ip: '1.2.3.4' } as any)).not.toHaveProperty('ip');
    expect(consentView(undefined)).toEqual({ status: 'none', at: null, source: null, note: null, askedAt: null });
  });
});

describe('Brevo CSV', () => {
  it('guards against formulas but keeps plain phone numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('+923001234567')).toBe('+923001234567');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });

  it('builds the import file with the agreed columns', () => {
    const csv = buildBrevoCsv([
      { email: 'ayesha@example.com', name: 'Ayesha Khan', businessName: '=cmd|calc', city: 'Lahore', phone: '0300 1234567', stage: 'new', source: 'website_form', utm: { campaign: 'eid' }, marketingConsent: { status: 'granted', at: new Date('2026-11-20T10:00:00Z'), source: 'demo_form' } },
    ]);
    const [head, row, end] = csv.split('\r\n');
    expect(head).toBe('EMAIL,FIRSTNAME,LASTNAME,COMPANY,CITY,WHATSAPP,LEAD_STAGE,LEAD_SOURCE,LEAD_CAMPAIGN,CONSENT_DATE,CONSENT_SOURCE');
    expect(row).toBe("ayesha@example.com,Ayesha,Khan,'=cmd|calc,Lahore,+923001234567,new,website_form,eid,2026-11-20,demo_form");
    expect(end).toBe('');
    expect(buildBrevoCsv([]).split('\r\n')).toHaveLength(2);
    expect(brevoCsvFilename(new Date('2026-11-24T08:00:00Z'))).toBe('solvexo-leads-brevo-2026-11-24.csv');
  });
});

describe('consent link token', () => {
  it('round-trips, and rejects tampering, expiry and other purposes', () => {
    const now = Date.now();
    const t = signConsentToken(LEAD, now);
    const v = verifyConsentToken(t, now + DAY);
    expect(v?.leadId).toBe(LEAD);
    expect(Math.abs(v!.issuedAt.getTime() - now)).toBeLessThan(5);
    expect(verifyConsentToken(t, now + 61 * DAY)).toBeNull();
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ l: 'f'.repeat(24), e: now + DAY, p: 'sales_marketing_consent' })).toString('base64url');
    expect(verifyConsentToken(`${forged}.${sig}`, now)).toBeNull();
    expect(verifyConsentToken(`${body}.${sig.slice(0, -2)}xx`, now)).toBeNull();
    expect(verifyConsentToken(`${body}.${sig}.x`, now)).toBeNull();
    expect(verifyConsentToken('garbage', now)).toBeNull();
    expect(verifyConsentToken('', now)).toBeNull();
  });

  it('compares secrets in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Brevo webhook parsing', () => {
  it('keeps only consent-withdrawing events, lower-cased and once per email', () => {
    expect(parseBrevoWebhook({ event: 'unsubscribed', email: 'Ayesha@Example.com' })).toEqual([{ email: 'ayesha@example.com', event: 'unsubscribed' }]);
    expect(parseBrevoWebhook([
      { event: 'opened', email: 'a@x.com' },
      { event: 'spam', email: 'b@x.com' },
      { event: 'hard_bounce', email: 'c@x.com' },
      { event: 'hardBounce', email: 'c@x.com' },
      { event: 'unsubscribed', email: 'not-an-email' },
      null,
      'junk',
    ])).toEqual([{ email: 'b@x.com', event: 'spam' }, { email: 'c@x.com', event: 'hard_bounce' }]);
    expect(parseBrevoWebhook(null)).toEqual([]);
    expect(parseBrevoWebhook('unsubscribed')).toEqual([]);
  });
});

describe('Brevo error text', () => {
  it('is short and never contains the key', () => {
    const key = 'xkeysib-abcdef0123456789-SECRET';
    const t = brevoErrorText(400, `bad key ${key} ${'x'.repeat(500)}`, key);
    expect(t).not.toContain('SECRET');
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t.startsWith('Brevo 400: bad key ••••')).toBe(true);
    expect(brevoErrorText(null, null)).toBe('Could not reach Brevo');
  });
});
