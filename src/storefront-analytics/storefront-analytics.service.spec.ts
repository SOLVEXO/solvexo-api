/* eslint-disable prettier/prettier */
import { StorefrontAnalyticsService } from './storefront-analytics.service';
import { classifyTrafficSource, countryFromSignals, deviceTypeFromUserAgent, externalReferrerHost, isBotUserAgent, cleanPath } from './storefront-analytics.util';
import { markStorefrontSession, readAnalyticsSessionId } from '../common/storefront-session.util';

const STORE = '64b000000000000000000001';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('storefront analytics utils', () => {
  it('classifies traffic like Shopify (utm first, then referrer kind, else direct)', () => {
    expect(classifyTrafficSource({})).toBe('direct');
    expect(classifyTrafficSource({ referrerHost: 'google.com' })).toBe('search');
    expect(classifyTrafficSource({ referrerHost: 'm.facebook.com' })).toBe('social');
    expect(classifyTrafficSource({ referrerHost: 'l.instagram.com' })).toBe('social');
    expect(classifyTrafficSource({ referrerHost: 'blog.example.org' })).toBe('referral');
    expect(classifyTrafficSource({ referrerHost: 'google.com', utmMedium: 'cpc' })).toBe('paid');
    expect(classifyTrafficSource({ utmMedium: 'email' })).toBe('email');
  });

  it('detects device type and bots', () => {
    expect(deviceTypeFromUserAgent(CHROME)).toBe('desktop');
    expect(deviceTypeFromUserAgent(IPHONE)).toBe('mobile');
    expect(deviceTypeFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet');
    expect(isBotUserAgent('Googlebot/2.1')).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent(CHROME)).toBe(false);
  });

  it('ignores the store\'s own hosts as referrers and never keeps query strings', () => {
    expect(externalReferrerHost('https://shop.solvexo.store/products/x', ['solvexo.store'])).toBeNull();
    expect(externalReferrerHost('https://www.google.com/search?q=x', ['solvexo.store'])).toBe('google.com');
    expect(externalReferrerHost('not a url', [])).toBeNull();
    expect(cleanPath('/products/shirt?email=a@b.com#x')).toBe('/products/shirt');
  });

  it('country: CDN header first, else an unambiguous browser time zone, else unknown', () => {
    expect(countryFromSignals('pk', null)).toBe('PK');
    expect(countryFromSignals(null, 'Asia/Karachi')).toBe('PK');
    expect(countryFromSignals('XX', 'Europe/London')).toBe('GB');
    expect(countryFromSignals(null, 'Etc/GMT+3')).toBeNull();
  });

  it('reads only a well-formed visit id from the request body', () => {
    expect(readAnalyticsSessionId({ analyticsSessionId: 'abc12345XYZ' })).toBe('abc12345XYZ');
    expect(readAnalyticsSessionId({ analyticsSessionId: { $ne: null } })).toBeNull();
    expect(readAnalyticsSessionId({ analyticsSessionId: 'bad id!' })).toBeNull();
    expect(readAnalyticsSessionId(undefined)).toBeNull();
  });

  it('funnel marks are cumulative (converted implies checkout and cart) and never throw', async () => {
    const model: any = { updateOne: jest.fn().mockResolvedValue({}) };
    await markStorefrontSession(model, STORE, 'sess12345', { converted: true, orderIds: ['o1'] });
    const [filter, update] = model.updateOne.mock.calls[0];
    expect(filter).toEqual({ storeId: STORE, sessionId: 'sess12345' });
    expect(update.$set).toMatchObject({ converted: true, reachedCheckout: true, addedToCart: true });
    expect(update.$addToSet).toEqual({ orderIds: { $each: ['o1'] } });
    model.updateOne.mockRejectedValue(new Error('db down'));
    await expect(markStorefrontSession(model, STORE, 'sess12345', { addedToCart: true })).resolves.toBeUndefined();
    await markStorefrontSession(model, STORE, 'x', { addedToCart: true }); // malformed id: no write
    expect(model.updateOne).toHaveBeenCalledTimes(2);
  });
});

describe('StorefrontAnalyticsService.recordPageView', () => {
  let sessionModel: any;
  let storeModel: any;
  let service: StorefrontAnalyticsService;
  const input = { storeId: STORE, sessionId: 'sess12345', visitorId: 'visit12345', path: '/products/a?x=1', referrer: 'https://www.google.com/', timeZone: 'Asia/Karachi' };

  beforeEach(() => {
    sessionModel = {
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 0 }),
      exists: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    };
    storeModel = { findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ slug: 'shop', status: 'active', isDelete: false, customDomains: [{ domain: 'myshop.com' }] }) }) }) };
    service = new StorefrontAnalyticsService({ repositories: { storefrontSessionModel: sessionModel, storeModel } } as any);
  });

  it('creates a new visit on its first page with source, device, landing page and country', async () => {
    const res = await service.recordPageView(input, { userAgent: IPHONE });
    expect(res.recorded).toBe(true);
    expect(sessionModel.create).toHaveBeenCalledWith(expect.objectContaining({
      storeId: STORE, sessionId: 'sess12345', visitorId: 'visit12345', pageViews: 1,
      landingPath: '/products/a', trafficSource: 'search', referrerHost: 'google.com', deviceType: 'mobile', country: 'PK', returningVisitor: false,
    }));
  });

  it('counts later pages on the same visit without creating another session', async () => {
    sessionModel.updateOne.mockResolvedValue({ matchedCount: 1 });
    await service.recordPageView(input, { userAgent: CHROME });
    expect(sessionModel.create).not.toHaveBeenCalled();
    expect(sessionModel.updateOne.mock.calls[0][1]).toMatchObject({ $inc: { pageViews: 1 }, $set: { currentPath: '/products/a' } });
  });

  it('marks a returning visitor', async () => {
    sessionModel.exists.mockResolvedValue({ _id: 'x' });
    await service.recordPageView(input, { userAgent: CHROME });
    expect(sessionModel.create.mock.calls[0][0].returningVisitor).toBe(true);
  });

  it('ignores bots, malformed ids and closed/unknown stores', async () => {
    expect((await service.recordPageView(input, { userAgent: 'Googlebot' })).recorded).toBe(false);
    expect((await service.recordPageView({ ...input, storeId: 'nope' }, { userAgent: CHROME })).recorded).toBe(false);
    storeModel.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'suspended', isDelete: false }) }) });
    const other = new StorefrontAnalyticsService({ repositories: { storefrontSessionModel: sessionModel, storeModel } } as any);
    expect((await other.recordPageView(input, { userAgent: CHROME })).recorded).toBe(false);
    expect(sessionModel.create).not.toHaveBeenCalled();
  });

  it('a race on the first page counts the view on the session the other request created', async () => {
    sessionModel.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const res = await service.recordPageView(input, { userAgent: CHROME });
    expect(res.recorded).toBe(true);
    expect(sessionModel.updateOne).toHaveBeenCalledTimes(2);
  });
});
