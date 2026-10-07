/* eslint-disable prettier/prettier */
import { createDecipheriv } from 'crypto';
import { EasypaisaRequestSigner } from './easypaisa.provider';

describe('EasypaisaRequestSigner', () => {
  const KEY = '0123456789abcdef';
  it('canonical query is alphabetical and skips empty values and the hash itself', () => {
    expect(EasypaisaRequestSigner.canonicalQuery({ storeId: '1', amount: '10.0', emailAddr: '', merchantHashedReq: 'x' })).toBe('amount=10.0&storeId=1');
  });
  it('merchantHashedReq is base64 AES-128-ECB of the canonical query', () => {
    const enc = EasypaisaRequestSigner.merchantHashedReq({ storeId: '1', amount: '10.0' }, KEY);
    const d = createDecipheriv('aes-128-ecb', Buffer.from(KEY), null);
    expect(Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString()).toBe('amount=10.0&storeId=1');
  });
  it('rejects a key that is not 16 characters', () => {
    expect(() => EasypaisaRequestSigner.merchantHashedReq({ a: '1' }, 'short')).toThrow('16');
  });
});
