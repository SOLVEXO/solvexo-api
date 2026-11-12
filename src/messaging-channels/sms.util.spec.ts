/* eslint-disable prettier/prettier */
import { getPath, mapSmsDelivery, mapSmsInbound, renderTemplate, smsSegments, STOP_FOOTER, validateHttpSmsConfig, withStopFooter } from './sms.util';

describe('smsSegments', () => {
  it('counts GSM-7 parts (160 single, 153 per part when joined)', () => {
    expect(smsSegments('')).toMatchObject({ segments: 0 });
    expect(smsSegments('Hello')).toEqual({ segments: 1, encoding: 'GSM-7', length: 5 });
    expect(smsSegments('a'.repeat(160)).segments).toBe(1);
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
    expect(smsSegments('{}').length).toBe(4); // extension characters count double
  });
  it('anything outside GSM-7 (Urdu, emoji) is UCS-2: 70 single, 67 per part', () => {
    expect(smsSegments('سلام')).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    expect(smsSegments('ا'.repeat(71)).segments).toBe(2);
    expect(smsSegments('Hi 😀')).toMatchObject({ encoding: 'UCS-2', length: 5 });
  });
});

describe('opt-out line', () => {
  it('is added once', () => {
    expect(withStopFooter('Sale today')).toBe(`Sale today\n${STOP_FOOTER}`);
    expect(withStopFooter(withStopFooter('Sale today'))).toBe(`Sale today\n${STOP_FOOTER}`);
  });
});

describe('renderTemplate', () => {
  const vars = { to: '923001234567', text: 'Say "hi" & go\n', sender: 'SHOP', secret: 's3cr&t' };
  it('escapes for json, form, url and raw', () => {
    expect(JSON.parse(renderTemplate('{"to":"{{to}}","m":"{{text}}"}', vars, 'json'))).toEqual({ to: '923001234567', m: 'Say "hi" & go\n' });
    expect(renderTemplate('to={{to}}&m={{ text }}', vars, 'form')).toBe('to=923001234567&m=Say%20%22hi%22%20%26%20go%0A');
    expect(renderTemplate('https://x.com/?k={{secret}}', vars, 'url')).toBe('https://x.com/?k=s3cr%26t');
    expect(renderTemplate('Bearer {{secret}}', vars, 'raw')).toBe('Bearer s3cr&t');
  });
  it('leaves unknown tags alone and never evaluates anything', () => {
    expect(renderTemplate('{{other}} {{constructor}} ${1+1}', vars, 'raw')).toBe('{{other}} {{constructor}} ${1+1}');
  });
  it('getPath reads dot paths from a JSON response', () => {
    expect(getPath({ data: { id: 42 } }, 'data.id')).toBe('42');
    expect(getPath({ data: null }, 'data.id')).toBeNull();
    expect(getPath({}, null)).toBeNull();
  });
});

describe('validateHttpSmsConfig', () => {
  const ok = { url: 'https://api.smsgateway.pk/send', method: 'POST' as const, contentType: 'json' as const, headers: { Authorization: 'Bearer {{secret}}' }, body: '{"to":"{{to}}","text":"{{text}}"}', successMatch: null, messageIdPath: 'id' };
  it('accepts a normal gateway', () => { expect(validateHttpSmsConfig(ok)).toBeNull(); });
  it('rejects http, IP addresses, credentials in the URL, private-looking hosts and missing placeholders', () => {
    expect(validateHttpSmsConfig({ ...ok, url: 'http://api.x.com/send' })).toMatch(/https/);
    expect(validateHttpSmsConfig({ ...ok, url: 'https://127.0.0.1/send' })).toMatch(/host name/);
    expect(validateHttpSmsConfig({ ...ok, url: 'https://10.0.0.5/send' })).toMatch(/host name/);
    expect(validateHttpSmsConfig({ ...ok, url: 'https://localhost/send' })).toMatch(/host name/);
    expect(validateHttpSmsConfig({ ...ok, url: 'https://user:pw@api.x.com/send' })).toMatch(/user name/);
    expect(validateHttpSmsConfig({ ...ok, body: '{"to":"{{to}}"}' })).toMatch(/\{\{text\}\}/);
    expect(validateHttpSmsConfig({ ...ok, body: '{"text":"{{text}}"}' })).toMatch(/\{\{to\}\}/);
    expect(validateHttpSmsConfig({ ...ok, url: 'nonsense' })).toMatch(/URL/);
    expect(validateHttpSmsConfig({ ...ok, method: 'PUT' as any })).toMatch(/GET or POST/);
  });
  it('GET gateways need {{text}} in the URL; headers are restricted', () => {
    const get = { ...ok, method: 'GET' as const, url: 'https://api.x.com/send?to={{to}}&text={{text}}&key={{secret}}', body: '' };
    expect(validateHttpSmsConfig(get)).toBeNull();
    expect(validateHttpSmsConfig({ ...get, url: 'https://api.x.com/send?to={{to}}' })).toMatch(/\{\{text\}\}/);
    expect(validateHttpSmsConfig({ ...ok, headers: { Host: 'evil.com' } })).toMatch(/cannot be set/);
    expect(validateHttpSmsConfig({ ...ok, headers: { 'X-A': 'a\r\nInjected: 1' } })).toMatch(/not valid/);
    expect(validateHttpSmsConfig({ ...ok, headers: { 'bad name': 'x' } })).toMatch(/not valid/);
    expect(validateHttpSmsConfig({ ...ok, messageIdPath: 'a b' })).toMatch(/path/);
  });
});

describe('webhook mapping', () => {
  it('reads common inbound field names, ignores the rest', () => {
    expect(mapSmsInbound({ from: '03001234567', text: 'STOP' })).toEqual({ from: '03001234567', text: 'STOP' });
    expect(mapSmsInbound({ msisdn: '923001234567', message: ' stop ' })).toEqual({ from: '923001234567', text: 'stop' });
    expect(mapSmsInbound({ from: '1' })).toBeNull();
    expect(mapSmsInbound(null)).toBeNull();
  });
  it('maps delivery reports to delivered / failed / sent', () => {
    expect(mapSmsDelivery({ id: 'a', status: 'DELIVERED' })).toEqual({ id: 'a', status: 'delivered' });
    expect(mapSmsDelivery({ message_id: 'b', dlr: 'UNDELIVERED' })).toEqual({ id: 'b', status: 'failed' });
    expect(mapSmsDelivery({ id: 'c', status: 'submitted' })).toEqual({ id: 'c', status: 'sent' });
    expect(mapSmsDelivery({ id: 'd', status: 'who knows' })).toBeNull();
    expect(mapSmsDelivery({ status: 'delivered' })).toBeNull();
  });
});
