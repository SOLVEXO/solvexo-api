/* eslint-disable prettier/prettier */
import { assertPublicUrl, publicUrlProblem, receiptUrlProblem } from './public-url.check';

describe('API_PUBLIC_URL boot check (G5.1)', () => {
  const prod = (v?: string) => publicUrlProblem(v, 'production');

  it('accepts a public https origin (with or without a trailing slash) in production / staging / unset NODE_ENV', () => {
    expect(prod('https://api.solvexo.store')).toBeNull();
    expect(prod('https://api.solvexo.store/')).toBeNull();
    expect(publicUrlProblem('https://staging-api.solvexo.store', 'staging')).toBeNull();
    expect(publicUrlProblem('https://api.solvexo.store', undefined)).toBeNull();
  });

  it('development and test are exempt (the dev stack is http://localhost)', () => {
    expect(publicUrlProblem(undefined, 'development')).toBeNull();
    expect(publicUrlProblem('http://localhost:3102', 'test')).toBeNull();
  });

  it('refuses: missing', () => {
    expect(prod(undefined)).toMatch(/not set/);
    expect(prod('   ')).toMatch(/not set/);
    expect(publicUrlProblem(undefined, undefined)).toMatch(/not set/); // NODE_ENV unset is NOT development
  });

  it('refuses: not a URL', () => expect(prod('api.solvexo.store')).toMatch(/not a valid URL/));

  it('refuses: not https', () => {
    expect(prod('http://api.solvexo.store')).toMatch(/must be https/);
    expect(prod('ftp://api.solvexo.store')).toMatch(/must be https/);
  });

  it('refuses: localhost and local names', () => {
    for (const h of ['localhost', 'app.localhost', 'printer.local', 'api.internal']) expect(prod(`https://${h}`)).toMatch(/local \/ private/);
  });

  it('refuses: private, loopback, link-local and CGNAT addresses (IPv4 and IPv6)', () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '172.16.4.1', '172.31.255.255', '192.168.1.10', '169.254.1.1', '100.64.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:192.168.1.1]']) {
      expect(prod(`https://${h}`)).toMatch(/local \/ private/);
    }
    expect(prod('https://172.32.0.1')).toBeNull(); // just outside 172.16/12 — public
    expect(prod('https://8.8.8.8')).toBeNull();
  });

  it('refuses: credentials, a path, a query or a fragment', () => {
    expect(prod('https://user:pw@api.solvexo.store')).toMatch(/credentials/);
    expect(prod('https://api.solvexo.store/api')).toMatch(/origin only/);
    expect(prod('https://api.solvexo.store/?x=1')).toMatch(/origin only/);
  });

  it('assertPublicUrl exits the process with 1 on a refusal and does nothing when fine', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    assertPublicUrl({ NODE_ENV: 'production', API_PUBLIC_URL: 'http://localhost:3000' } as any);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    assertPublicUrl({ NODE_ENV: 'production', API_PUBLIC_URL: 'https://api.solvexo.store' } as any);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore(); err.mockRestore();
  });

  it('G5.2.0b RECEIPT_PUBLIC_URL: optional; when set, the same rules (https, origin only, not local / private); boot refuses an invalid one', () => {
    expect(receiptUrlProblem(undefined, 'production')).toBeNull();
    expect(receiptUrlProblem('', 'production')).toBeNull();
    expect(receiptUrlProblem('https://solvexo.store', 'production')).toBeNull();
    expect(receiptUrlProblem('http://solvexo.store', 'production')).toMatch(/RECEIPT_PUBLIC_URL must be https/);
    expect(receiptUrlProblem('https://localhost', 'production')).toMatch(/local \/ private/);
    expect(receiptUrlProblem('https://solvexo.store/r', 'production')).toMatch(/origin only/);
    expect(receiptUrlProblem('http://localhost:3000', 'development')).toBeNull();
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    assertPublicUrl({ NODE_ENV: 'production', API_PUBLIC_URL: 'https://api.solvexo.store', RECEIPT_PUBLIC_URL: 'http://solvexo.store' } as any);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    assertPublicUrl({ NODE_ENV: 'production', API_PUBLIC_URL: 'https://api.solvexo.store', RECEIPT_PUBLIC_URL: 'https://solvexo.store' } as any);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore(); err.mockRestore();
  });
});
