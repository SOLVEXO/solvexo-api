/* eslint-disable prettier/prettier */
import { advanceStatus, canSendTemplate, chunk, contactKey, countsFromStatuses, hasConsent, isStopKeyword, remainingToday, templateParamCount, validateTemplateInput } from './messaging-rules.util';

describe('consent', () => {
  it('only an explicit opt-in counts', () => {
    expect(hasConsent({ status: 'opted_in' })).toBe(true);
    expect(hasConsent({ status: 'opted_out' })).toBe(false);
    expect(hasConsent(null)).toBe(false);
    expect(hasConsent({})).toBe(false);
  });
  it('contact keys collapse Pakistani formats', () => {
    expect(contactKey('0300-1234567')).toBe('923001234567');
    expect(contactKey('+92 300 1234567')).toBe('923001234567');
    expect(contactKey('abc')).toBeNull();
  });
  it('STOP keywords are recognised in any case and with punctuation, long sentences are not', () => {
    for (const t of ['STOP', 'stop.', ' Unsubscribe ', 'Stop all!', 'opt out', 'Cancel']) expect(isStopKeyword(t)).toBe(true);
    for (const t of ['please do not stop shipping my order', 'ok', '', 'stopwatch', null, 42]) expect(isStopKeyword(t as any)).toBe(false);
  });
});

describe('daily limit and batching', () => {
  it('remainingToday never goes below zero', () => {
    expect(remainingToday(1000, 0)).toBe(1000);
    expect(remainingToday(1000, 400)).toBe(600);
    expect(remainingToday(1000, 1500)).toBe(0);
    expect(remainingToday(10, -5)).toBe(10);
  });
  it('chunk splits evenly and handles empty', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
    expect(chunk(Array.from({ length: 120 }, (_, i) => i)).map((c) => c.length)).toEqual([50, 50, 20]);
  });
});

describe('validateTemplateInput', () => {
  const ok = { name: 'eid_sale', language: 'en_US', bodyText: 'Hi {{1}}, our sale ends {{2}}.', examples: ['Ali', 'Friday'] };
  it('accepts a valid marketing template', () => { expect(validateTemplateInput(ok)).toBeNull(); });
  it('rejects bad names, languages, empty or too long text', () => {
    expect(validateTemplateInput({ ...ok, name: 'Eid Sale' })).toMatch(/lowercase/);
    expect(validateTemplateInput({ ...ok, language: 'english' })).toMatch(/Language/);
    expect(validateTemplateInput({ ...ok, bodyText: '  ' })).toMatch(/Write/);
    expect(validateTemplateInput({ ...ok, bodyText: 'x'.repeat(1025), examples: [] })).toMatch(/1024/);
  });
  it('placeholders must be 1..n without gaps, numeric, each with an example', () => {
    expect(validateTemplateInput({ ...ok, bodyText: 'Hi {{1}} {{3}}', examples: ['a', 'b'] })).toMatch(/without gaps/);
    expect(validateTemplateInput({ ...ok, bodyText: 'Hi {{name}}', examples: [] })).toMatch(/numbers/);
    expect(validateTemplateInput({ ...ok, examples: ['Ali'] })).toMatch(/example value for each of the 2/);
    expect(validateTemplateInput({ ...ok, examples: ['Ali', ' '] })).toMatch(/cannot be empty/);
    expect(validateTemplateInput({ name: 'plain', language: 'ur', bodyText: 'No variables', examples: [] })).toBeNull();
    expect(templateParamCount('{{1}} and {{1}} and {{2}}')).toBe(2);
  });
});

describe('status handling', () => {
  it('only approved templates may be used', () => {
    expect(canSendTemplate('APPROVED')).toBe(true);
    expect(canSendTemplate('approved')).toBe(true);
    for (const s of ['PENDING', 'REJECTED', 'PAUSED', '', null, undefined]) expect(canSendTemplate(s as any)).toBe(false);
  });
  it('delivery reports only move a message forward, failures never overwrite a delivered one', () => {
    expect(advanceStatus('sent', 'delivered')).toBe('delivered');
    expect(advanceStatus('delivered', 'sent')).toBe('delivered');
    expect(advanceStatus('delivered', 'read')).toBe('read');
    expect(advanceStatus('read', 'delivered')).toBe('read');
    expect(advanceStatus('sent', 'failed')).toBe('failed');
    expect(advanceStatus('delivered', 'failed')).toBe('delivered');
    expect(advanceStatus('sent', 'weird')).toBe('sent');
    expect(advanceStatus('skipped_opted_out', 'delivered')).toBe('skipped_opted_out');
  });
  it('campaign figures: a read message counts as delivered and sent', () => {
    expect(countsFromStatuses({ queued: 3, sending: 1, sent: 2, delivered: 4, read: 5, failed: 1, skipped_opted_out: 2, skipped_no_consent: 1 })).toEqual({ queued: 4, sent: 11, delivered: 9, read: 5, failed: 1, skipped: 3, total: 19 });
  });
});
