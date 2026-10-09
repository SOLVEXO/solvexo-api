/* eslint-disable prettier/prettier */
import { createDecipheriv } from 'crypto';
import { EasypaisaPaymentProvider, EasypaisaRequestSigner, toEasypaisaMobileAccount } from './easypaisa.provider';

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

describe('EasypaisaPaymentProvider (REST v4 mobile account)', () => {
  const CONFIG: any = {
    mode: 'sandbox', webhookToken: 'tok', config: {},
    credentials: { easypaisaStoreId: '12345', accountNum: '987', username: 'user', password: 'pass' },
  };
  const ORDER: any = { orderId: 'c1', amount: 1500, currency: 'PKR', storeId: 's1', returnUrl: 'https://shop.solvexo.store/checkout/c1/return', cancelUrl: 'https://shop.solvexo.store/checkout', buyerPhone: '+92 300 1234567' };
  const reply = (body: any, ok = true) => jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, text: () => Promise.resolve(JSON.stringify(body)) });
  let provider: EasypaisaPaymentProvider;
  beforeEach(() => { provider = new EasypaisaPaymentProvider(); });
  afterEach(() => { (global as any).fetch = undefined; });

  it('normalises Pakistani mobile numbers to the 03XXXXXXXXX account format', () => {
    expect(toEasypaisaMobileAccount('+92 300-1234567')).toBe('03001234567');
    expect(toEasypaisaMobileAccount('923001234567')).toBe('03001234567');
    expect(toEasypaisaMobileAccount('03001234567')).toBe('03001234567');
    expect(toEasypaisaMobileAccount('0300123')).toBeNull();
    expect(toEasypaisaMobileAccount('04212345678')).toBeNull();
  });

  it('initiatePayment opens a session and sends the buyer to the return page (no gateway call, no redirect to Easypaisa)', async () => {
    (global as any).fetch = jest.fn();
    const s = await provider.initiatePayment(ORDER, CONFIG);
    expect(s.sessionId).toMatch(/^SX[0-9A-Z]+$/);
    expect(s.redirectUrl).toBe('https://shop.solvexo.store/checkout/c1/return?wallet=easypaisa');
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('initiatePayment refuses a missing/invalid Easypaisa number, non-PKR and missing credentials', async () => {
    await expect(provider.initiatePayment({ ...ORDER, buyerPhone: undefined }, CONFIG)).rejects.toThrow('Easypaisa account');
    await expect(provider.initiatePayment({ ...ORDER, currency: 'USD' }, CONFIG)).rejects.toThrow('PKR');
    await expect(provider.initiatePayment(ORDER, { ...CONFIG, credentials: {} })).rejects.toThrow('required');
  });

  it('startPushPayment calls initiate-ma-transaction with the Credentials header and the buyer-entered wallet number', async () => {
    (global as any).fetch = reply({ responseCode: '0000', orderId: 'SX1' });
    await provider.startPushPayment({ ...ORDER, walletAccount: '0345 1112223' }, 'SX1', CONFIG);
    const [url, init] = (global as any).fetch.mock.calls[0];
    expect(url).toBe('https://easypaystg.easypaisa.com.pk/easypay-service/rest/v4/initiate-ma-transaction');
    expect(init.headers.Credentials).toBe(Buffer.from('user:pass').toString('base64'));
    expect(JSON.parse(init.body)).toMatchObject({ orderId: 'SX1', storeId: '12345', accountNum: '987', transactionAmount: '1500.00', transactionType: 'MA', mobileAccountNo: '03451112223' });
  });

  it('verifyPayment maps PAID with the amount Easypaisa reports', async () => {
    (global as any).fetch = reply({ responseCode: '0000', storeId: '12345', transactionStatus: 'PAID', transactionAmount: 1500 });
    const st = await provider.verifyPayment('SX1', CONFIG);
    expect(st).toMatchObject({ status: 'paid', amount: 1500, currency: 'PKR' });
    expect((global as any).fetch.mock.calls[0][0]).toContain('/easypay-service/rest/v4/inquire-transaction');
  });

  it('verifyPayment maps FAILED/EXPIRED/BLOCKED to failed, REVERSED to refunded, PENDING to pending', async () => {
    for (const [s, want] of [['FAILED', 'failed'], ['EXPIRED', 'failed'], ['BLOCKED', 'failed'], ['REVERSED', 'refunded'], ['PENDING', 'pending']]) {
      (global as any).fetch = reply({ responseCode: '0000', storeId: '12345', transactionStatus: s, transactionAmount: 1500 });
      expect((await provider.verifyPayment('SX1', CONFIG)).status).toBe(want);
    }
  });

  it('a failed inquiry call is never read as a payment result', async () => {
    (global as any).fetch = reply({ responseCode: '0001', responseDesc: 'SYSTEM ERROR' });
    expect((await provider.verifyPayment('SX1', CONFIG)).status).toBe('pending');
  });

  it('REGRESSION: a PAID answer for another Easypaisa store is not accepted', async () => {
    (global as any).fetch = reply({ responseCode: '0000', storeId: '99999', transactionStatus: 'PAID', transactionAmount: 1500 });
    expect((await provider.verifyPayment('SX1', CONFIG)).status).toBe('failed');
  });

  it('never accepts a callback — results only come from the inquiry API', async () => {
    expect(provider.callbackIsAuthoritative).toBe(false);
    await expect(provider.handleWebhook()).rejects.toThrow('inquiry');
  });

  it('testConnection: invalid credentials fail, unknown order id (0003) passes', async () => {
    (global as any).fetch = reply({ responseCode: '0010', responseDesc: 'INVALID CREDENTIALS' });
    expect((await provider.testConnection(CONFIG)).ok).toBe(false);
    (global as any).fetch = reply({ responseCode: '0003', responseDesc: 'INVALID ORDER ID' });
    expect((await provider.testConnection(CONFIG)).ok).toBe(true);
  });
});
