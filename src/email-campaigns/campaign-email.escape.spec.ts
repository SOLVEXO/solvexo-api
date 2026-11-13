import { renderCampaignEmail } from './campaign-email.util';

describe('campaign email merge tags', () => {
  const evil = '<img src=x onerror=alert(1)>';

  it('a buyer-controlled name cannot inject HTML into the body', () => {
    const out = renderCampaignEmail({ subject: 'Hi {{customerName}}', message: '<p>Hello {{customerName}} from {{storeName}}</p>', customerName: evil, storeName: 'A & B', ctaUrl: null });
    expect(out.html.includes('<img src=x')).toBe(false);
    expect(out.html.includes('&lt;img src=x')).toBe(true);
    expect(out.html.includes('A &amp; B')).toBe(true);
  });

  it('the subject is plain text and keeps the name exactly as typed', () => {
    const out = renderCampaignEmail({ subject: 'Hi {{customerName}}', message: '<p>x</p>', customerName: 'Ali & Sons', storeName: 'S', ctaUrl: null });
    expect(out.subject).toBe('Hi Ali & Sons');
  });

  it('ordinary names pass through unchanged', () => {
    const out = renderCampaignEmail({ subject: 's', message: '<p>Dear {{customerName}}</p>', customerName: 'Ayesha', storeName: 'S', ctaUrl: null });
    expect(out.html.includes('Dear Ayesha')).toBe(true);
  });
});
