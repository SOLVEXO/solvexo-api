import { renderCampaignEmail } from './campaign-email.util';
import { footerAddressHtml, withAddress } from '../newsletter/marketing-email.util';

describe('the store mailing address in marketing email footers', () => {
  it('footerAddressHtml prints one safe line, or nothing', () => {
    expect(footerAddressHtml('12 Main Street,\n  Lahore  ')).toBe('<br />12 Main Street, Lahore');
    expect(footerAddressHtml('<script>alert(1)</script>')).toBe('<br />&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(footerAddressHtml('   ')).toBe('');
    expect(footerAddressHtml(null)).toBe('');
    expect(footerAddressHtml(undefined)).toBe('');
  });

  it('withAddress appends the address to a plain-text reason, or leaves it alone', () => {
    expect(withAddress("You're receiving this because you subscribed.", '12 Main Street')).toBe("You're receiving this because you subscribed. 12 Main Street");
    expect(withAddress('Reason', '')).toBe('Reason');
    expect(withAddress('Reason', null)).toBe('Reason');
  });

  const base = { subject: 'Hi', message: '<p>Hello {{customerName}}</p>', customerName: 'Sana', storeName: 'Shop One', ctaUrl: null, unsubscribeUrl: 'https://x/unsub' };

  it('a campaign email carries the store address in its footer, escaped', () => {
    const { html } = renderCampaignEmail({ ...base, storeAddress: '12 Main Street & Sons, Lahore' });
    expect(html).toContain('12 Main Street &amp; Sons, Lahore');
    expect(html).toContain('Unsubscribe');
  });

  it('a campaign email without an address looks exactly as before (no empty line)', () => {
    const withIt = renderCampaignEmail({ ...base, storeAddress: null }).html;
    const without = renderCampaignEmail({ ...base }).html;
    expect(withIt).toBe(without);
    expect(without).not.toContain('<br /><br />');
  });
});
