/* eslint-disable prettier/prettier */
import {
  buildPayload, classifyNetworkError, fbrTokenFingerprint, FBR_URLS, interpretResponse, isValidFbrInvoiceNumber, normalizeHsCode,
  normalizeNtnCnic, pktDate, platformInvoiceTreatment, qrText, rateString, retryDelayMinutes, validateInvoiceInput, FbrInvoiceInput,
} from './fbr-di.util';

const base = (): FbrInvoiceInput => ({
  invoiceType: 'Sale Invoice', invoiceDate: '2026-11-11',
  sellerNTNCNIC: '1234567', sellerBusinessName: 'Solvexo', sellerProvince: 'Sindh', sellerAddress: 'Karachi',
  buyerNTNCNIC: null, buyerBusinessName: 'Ali Store', buyerProvince: 'Punjab', buyerAddress: 'Lahore',
  buyerRegistrationType: 'Unregistered', scenarioId: 'SN019',
  items: [{ hsCode: '9815.0000', productDescription: 'Plan', rate: '18%', uoM: 'Numbers, pieces, units', quantity: 1, totalValues: 1180, valueSalesExcludingST: 1000, salesTaxApplicable: 180, saleType: 'Services' }],
});

describe('fbr-di.util', () => {
  it('uses the sandbox URLs with _sb and the production URLs without', () => {
    expect(FBR_URLS.sandbox.post.endsWith('postinvoicedata_sb')).toBe(true);
    expect(FBR_URLS.sandbox.validate.endsWith('validateinvoicedata_sb')).toBe(true);
    expect(FBR_URLS.production.post.endsWith('postinvoicedata')).toBe(true);
    expect(FBR_URLS.production.validate.endsWith('validateinvoicedata')).toBe(true);
  });

  it('normalises NTN/CNIC (drops dashes and the check digit of an 8-digit NTN)', () => {
    expect(normalizeNtnCnic('1234567-8')).toBe('1234567');
    expect(normalizeNtnCnic('1234567')).toBe('1234567');
    expect(normalizeNtnCnic('42101-1234567-1')).toBe('4210112345671');
    expect(normalizeNtnCnic(null)).toBe('');
  });

  it('formats HS codes as 0000.0000 or rejects them', () => {
    expect(normalizeHsCode('0101.2100')).toBe('0101.2100');
    expect(normalizeHsCode('01012100')).toBe('0101.2100');
    expect(normalizeHsCode('0101')).toBe('');
    expect(normalizeHsCode(undefined)).toBe('');
  });

  it('prints the rate like the rate API does', () => {
    expect(rateString(18)).toBe('18%');
    expect(rateString(0)).toBe('0%');
    expect(rateString(17.5)).toBe('17.5%');
  });

  it('uses the Pakistani calendar date', () => {
    expect(pktDate(new Date('2026-11-10T20:00:00Z'))).toBe('2026-11-11'); // 01:00 on the 11th in Karachi
    expect(pktDate(new Date('2026-11-10T18:59:59Z'))).toBe('2026-11-10'); // 23:59:59 on the 10th in Karachi
    expect(pktDate(new Date('2026-11-10T19:00:00Z'))).toBe('2026-11-11'); // exactly midnight in Karachi
  });

  it('accepts a complete invoice', () => {
    expect(validateInvoiceInput(base()).length).toBe(0);
  });

  it('reports every missing or bad field in plain words', () => {
    const i = base();
    i.sellerNTNCNIC = '12'; i.buyerProvince = ''; i.items[0].hsCode = 'x'; i.items[0].quantity = 0;
    const p = validateInvoiceInput(i).join(' | ');
    expect(p.includes('Seller NTN/CNIC')).toBe(true);
    expect(p.includes('Buyer province')).toBe(true);
    expect(p.includes('HS code')).toBe(true);
    expect(p.includes('quantity')).toBe(true);
  });

  it('requires an NTN for a registered buyer, refuses self-invoicing, and needs a reference for a debit note', () => {
    const a = base(); a.buyerRegistrationType = 'Registered';
    expect(validateInvoiceInput(a).join(' ').includes('registered buyer needs')).toBe(true);
    const b = base(); b.buyerRegistrationType = 'Registered'; b.buyerNTNCNIC = '1234567';
    expect(validateInvoiceInput(b).join(' ').includes('self-invoicing')).toBe(true);
    const c = base(); c.invoiceType = 'Debit Note';
    expect(validateInvoiceInput(c).join(' ').includes('original FBR invoice number')).toBe(true);
  });

  it('builds the exact spec payload: scenarioId only in sandbox, no buyer NTN when empty, numbers rounded', () => {
    const sb: any = buildPayload(base(), 'sandbox');
    expect(sb.scenarioId).toBe('SN019');
    expect('buyerNTNCNIC' in sb).toBe(false);
    expect(sb.invoiceRefNo).toBe('');
    expect(sb.items[0].salesTaxApplicable).toBe(180);
    expect(sb.items[0].sroScheduleNo).toBe('');
    const prod: any = buildPayload(base(), 'production');
    expect('scenarioId' in prod).toBe(false);
    const withBuyer: any = buildPayload({ ...base(), buyerRegistrationType: 'Registered', buyerNTNCNIC: '7654321' }, 'production');
    expect(withBuyer.buyerNTNCNIC).toBe('7654321');
    const rounded: any = buildPayload({ ...base(), items: [{ ...base().items[0], valueSalesExcludingST: 10.005, quantity: 1.23456 }] }, 'production');
    expect(rounded.items[0].quantity).toBe(1.2346);
  });

  it('reads a valid post response', () => {
    const r = interpretResponse(200, { invoiceNumber: '1234567DI1747119701593', dated: '2025-05-13 12:01:41', validationResponse: { statusCode: '00', status: 'Valid', error: '', invoiceStatuses: [{ itemSNo: '1', statusCode: '00', status: 'Valid', invoiceNo: '1234567DI1747119701593-1', errorCode: '', error: '' }] } });
    expect(r.ok).toBe(true);
    expect(r.invoiceNumber).toBe('1234567DI1747119701593');
    expect(r.errors.length).toBe(0);
  });

  it('treats the spec 4.1.5 answer (HTTP 200, header 00, item invalid) as REJECTED, not success', () => {
    const r = interpretResponse(200, { dated: 'd', validationResponse: { statusCode: '00', status: 'invalid', error: '', invoiceStatuses: [{ itemSNo: '1', statusCode: '01', status: 'Invalid', invoiceNo: null, errorCode: '0046', error: 'Provide rate.' }] } });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.errors[0].code).toBe('0046');
    expect(r.errors[0].itemSNo).toBe('1');
  });

  it('treats the spec 4.1.4 answer (header 01) as rejected with the FBR message', () => {
    const r = interpretResponse(200, { dated: 'd', validationResponse: { statusCode: '01', status: 'Invalid', errorCode: '0052', error: 'Provide proper HS Code with invoice no. null', invoiceStatuses: null } });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('0052');
  });

  it('does not count a "valid" answer without an invoice number as posted', () => {
    const r = interpretResponse(200, { dated: 'd', validationResponse: { statusCode: '00', status: 'Valid', error: '', invoiceStatuses: [] } });
    expect(r.ok).toBe(false);
    const v = interpretResponse(200, { dated: 'd', validationResponse: { statusCode: '00', status: 'Valid', error: '', invoiceStatuses: [] } }, null, false);
    expect(v.ok).toBe(true);
  });

  // CHANGED ON PURPOSE (Phase 0): before, a 5xx / timeout / unreadable answer was "retryable". FBR has no duplicate-check API, so now
  // only a request that provably never left is retryable; everything that may have reached FBR is an UNKNOWN outcome.
  it('401 is a token problem: not retryable, not unknown', () => {
    const r = interpretResponse(401, null);
    expect(r.authError).toBe(true);
    expect(r.retryable).toBe(false);
    expect(r.unknownOutcome).toBe(false);
  });

  it('a request that provably never left (DNS / connection refused) is retryable and NOT unknown', () => {
    const r = interpretResponse(null, null, 'ECONNREFUSED', true, true);
    expect(r.retryable).toBe(true);
    expect(r.notSent).toBe(true);
    expect(r.unknownOutcome).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('a timeout / reset (the request may have arrived) is an UNKNOWN outcome, never retryable', () => {
    for (const msg of ['timed out waiting for FBR', 'ECONNRESET', 'UND_ERR_SOCKET']) {
      const r = interpretResponse(null, null, msg, true, false);
      expect(r.unknownOutcome).toBe(true);
      expect(r.retryable).toBe(false);
      expect(r.notSent).toBe(false);
    }
  });

  it('a 5xx is an UNKNOWN outcome, never retryable', () => {
    for (const code of [500, 502, 503, 504]) {
      const r = interpretResponse(code, null);
      expect(r.unknownOutcome).toBe(true);
      expect(r.retryable).toBe(false);
    }
  });

  it('an unreadable 200 body, or a 200 without a validation result, is UNKNOWN (it may have been filed)', () => {
    expect(interpretResponse(200, 'oops').unknownOutcome).toBe(true);
    expect(interpretResponse(200, null).unknownOutcome).toBe(true);
    expect(interpretResponse(200, { dated: 'd' }).unknownOutcome).toBe(true);
    expect(interpretResponse(200, { dated: 'd' }).ok).toBe(false);
  });

  it('a "valid" answer WITHOUT an invoice number is UNKNOWN: it may be filed but we cannot record it', () => {
    const r = interpretResponse(200, { dated: 'd', validationResponse: { statusCode: '00', status: 'Valid', error: '', invoiceStatuses: [] } });
    expect(r.ok).toBe(false);
    expect(r.unknownOutcome).toBe(true);
  });

  it('a gateway refusal (4xx other than 401, no body) is a plain rejection: not unknown, not retryable', () => {
    for (const code of [400, 403, 404, 429]) {
      const r = interpretResponse(code, null);
      expect(r.ok).toBe(false);
      expect(r.unknownOutcome).toBe(false);
      expect(r.retryable).toBe(false);
      expect(r.errors[0].code).toBe(String(code));
    }
  });

  it('a rejected invoice (HTTP 200, header 01 or item 01) is neither unknown nor retryable', () => {
    const r = interpretResponse(200, { dated: 'd', validationResponse: { statusCode: '01', status: 'Invalid', errorCode: '0052', error: 'bad', invoiceStatuses: null } });
    expect(r.unknownOutcome).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it('classifyNetworkError: only name lookup / connect / TLS-refused errors count as "not sent"', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(classifyNetworkError({ message: 'fetch failed', cause: { code } }).notSent).toBe(true);
    }
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'EPIPE', 'SOMETHING_NEW', '']) {
      expect(classifyNetworkError({ message: 'fetch failed', cause: { code } }).notSent).toBe(false);
    }
    expect(classifyNetworkError({ name: 'AbortError', message: 'aborted' }).notSent).toBe(false);
    expect(classifyNetworkError(new Error('weird')).notSent).toBe(false);
  });

  it('classifyNetworkError never puts a URL or a header (token) into the message', () => {
    const e: any = new Error('fetch failed for https://gw.fbr.gov.pk/x with Authorization: Bearer SECRET-TOKEN-123');
    e.cause = { code: 'ECONNREFUSED' };
    expect(classifyNetworkError(e).message).toBe('ECONNREFUSED');
    expect(classifyNetworkError({ message: 'x'.repeat(500) }).message.length).toBe(120);
  });

  it('FBR invoice numbers: 7-digit NTN or 13-digit CNIC + DI + 13 digits (22 or 28 characters)', () => {
    expect(isValidFbrInvoiceNumber('7000007DI1747119701593')).toBe(true);
    expect(isValidFbrInvoiceNumber('4210112345671DI1747119701593')).toBe(true);
    expect(isValidFbrInvoiceNumber(' 7000007DI1747119701593 ')).toBe(true);
    for (const bad of ['', 'abc', '7000007XX1747119701593', '700000DI1747119701593', '7000007DI174711970159', '7000007DI17471197015934', '7327556DI1744111990654-1']) {
      expect(isValidFbrInvoiceNumber(bad)).toBe(false);
    }
  });

  it('token fingerprint: 12 hex characters, stable, different per token, never the token itself', () => {
    const a = fbrTokenFingerprint('token-A-aaaaaaaaaaaaaaaa');
    expect(/^[0-9a-f]{12}$/.test(a)).toBe(true);
    expect(fbrTokenFingerprint('token-A-aaaaaaaaaaaaaaaa')).toBe(a);
    expect(fbrTokenFingerprint('token-B-bbbbbbbbbbbbbbbb')).not.toBe(a);
    expect('token-A-aaaaaaaaaaaaaaaa'.includes(a)).toBe(false);
  });

  it('platform invoice treatment: only Pakistani-rule tax above zero is eligible', () => {
    const ok = { subtotalUSD: 50, taxCountry: 'PK', taxAmountUSD: 9, taxRatePercent: 18 };
    expect(platformInvoiceTreatment(ok).eligible).toBe(true);
    expect(platformInvoiceTreatment({ ...ok, taxCountry: 'pk' }).eligible).toBe(true);
  });

  it('platform invoice treatment: a foreign tax country is HELD with a reason that does not exclude the customer for being foreign', () => {
    const t = platformInvoiceTreatment({ subtotalUSD: 50, taxCountry: 'GB', taxAmountUSD: 10, taxRatePercent: 20 });
    expect(t.eligible).toBe(false);
    expect(String(t.reason).includes('GB')).toBe(true);
    expect(String(t.reason).includes('not verified')).toBe(true);
  });

  it('platform invoice treatment: missing country, zero tax and missing tax data are all HELD, and missing data is UNKNOWN not zero', () => {
    expect(platformInvoiceTreatment({ subtotalUSD: 50, taxCountry: null, taxAmountUSD: 9, taxRatePercent: 18 }).eligible).toBe(false);
    expect(platformInvoiceTreatment({ subtotalUSD: 50, taxCountry: '', taxAmountUSD: 9, taxRatePercent: 18 }).eligible).toBe(false);
    const zero = platformInvoiceTreatment({ subtotalUSD: 50, taxCountry: 'PK', taxAmountUSD: 0, taxRatePercent: 0 });
    expect(zero.eligible).toBe(false);
    expect(String(zero.reason).includes('zero-rated')).toBe(true);
    const unknown = platformInvoiceTreatment({ subtotalUSD: null, taxCountry: 'PK', taxAmountUSD: 0, taxRatePercent: 0 });
    expect(unknown.eligible).toBe(false);
    expect(String(unknown.reason).includes('UNKNOWN')).toBe(true);
    expect(platformInvoiceTreatment({}).eligible).toBe(false);
  });

  it('backs off 5m, 15m, 1h, 6h, then daily', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMinutes)).toEqual([5, 15, 60, 360, 1440, 1440]);
  });

  it('encodes the FBR invoice number in the QR', () => {
    expect(qrText('1234567DI1')).toBe('1234567DI1');
  });
});
