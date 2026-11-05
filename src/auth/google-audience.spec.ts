import { AuthService } from './auth.service';

/** GOOGLE_CLIENT_ID can list several web clients (comma-separated), so the website can move to a new client while the
 *  mobile and POS apps keep signing in with the old one. */
describe('AuthService Google token audience', () => {
  const saved = process.env.GOOGLE_CLIENT_ID;
  afterEach(() => { process.env.GOOGLE_CLIENT_ID = saved; });

  function serviceWith(verifyIdToken: jest.Mock) {
    const service = Object.create(AuthService.prototype) as AuthService;
    (service as any).googleClient = { verifyIdToken };
    return service;
  }
  const ticket = { getPayload: () => ({ sub: 'g-1', email: 'Seller@Example.com', email_verified: true }) };

  it('passes every listed client as an accepted audience', async () => {
    process.env.GOOGLE_CLIENT_ID = ' old.apps.googleusercontent.com , new.apps.googleusercontent.com ';
    const verify = jest.fn().mockResolvedValue(ticket);
    await expect(serviceWith(verify).verifyProviderIdentity('google', 'g-1', 'id-token')).resolves.toBe('seller@example.com');
    expect(verify).toHaveBeenCalledWith({ idToken: 'id-token', audience: ['old.apps.googleusercontent.com', 'new.apps.googleusercontent.com'] });
  });

  it('keeps a single client as a plain string', async () => {
    process.env.GOOGLE_CLIENT_ID = 'only.apps.googleusercontent.com';
    const verify = jest.fn().mockResolvedValue(ticket);
    await serviceWith(verify).verifyProviderIdentity('google', 'g-1', 'id-token');
    expect(verify).toHaveBeenCalledWith({ idToken: 'id-token', audience: 'only.apps.googleusercontent.com' });
  });

  it('rejects a token for another Google account', async () => {
    process.env.GOOGLE_CLIENT_ID = 'only.apps.googleusercontent.com';
    const verify = jest.fn().mockResolvedValue(ticket);
    await expect(serviceWith(verify).verifyProviderIdentity('google', 'someone-else', 'id-token')).rejects.toThrow('Invalid Google token');
  });
});
