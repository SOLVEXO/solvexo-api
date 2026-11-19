import { withEmailUtm } from './campaign-email.util';
import { slugifyCampaignName } from '../marketing-campaigns/marketing-campaigns.service';

const STORE = 'https://shop.solvexo.store';

describe('withEmailUtm — email links are tagged so Growth can credit the sales', () => {
  it('tags a link to the store with source, medium and the campaign', () => {
    const url = withEmailUtm(`${STORE}/product/shoes?size=9`, STORE, 'summer-sale');
    const u = new URL(url);
    expect(u.searchParams.get('size')).toBe('9');
    expect(u.searchParams.get('utm_source')).toBe('solvexo_email');
    expect(u.searchParams.get('utm_medium')).toBe('email');
    expect(u.searchParams.get('utm_campaign')).toBe('summer-sale');
  });

  it('treats www and the bare host as the same store', () => {
    expect(withEmailUtm('https://www.shop.solvexo.store/', STORE, 'x')).toContain('utm_medium=email');
  });

  it('leaves other websites alone', () => {
    expect(withEmailUtm('https://instagram.com/mystore', STORE, 'x')).toBe('https://instagram.com/mystore');
  });

  it('keeps a link the seller already tagged themselves', () => {
    const own = `${STORE}/?utm_source=newsletter&utm_medium=email&utm_campaign=custom`;
    expect(withEmailUtm(own, STORE, 'auto')).toBe(own);
  });

  it('does nothing without a store address, and survives a bad link', () => {
    expect(withEmailUtm(`${STORE}/a`, null, 'x')).toBe(`${STORE}/a`);
    expect(withEmailUtm('not a url', STORE, 'x')).toBe('not a url');
  });

  it('leaves utm_campaign out when the campaign has no usable name', () => {
    expect(new URL(withEmailUtm(`${STORE}/`, STORE, '')).searchParams.has('utm_campaign')).toBe(false);
  });
});

describe('slugifyCampaignName', () => {
  it('makes a URL-safe campaign tag from a name', () => {
    expect(slugifyCampaignName('Summer Sale 2026!')).toBe('summer-sale-2026');
    expect(slugifyCampaignName('  --Eid / Mega  Sale--  ')).toBe('eid-mega-sale');
    expect(slugifyCampaignName('!!!')).toBe('');
    expect(slugifyCampaignName('x'.repeat(300)).length).toBe(100);
  });
});
