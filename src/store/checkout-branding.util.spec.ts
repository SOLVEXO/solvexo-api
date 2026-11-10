import { cleanCheckoutBranding } from './checkout-branding.util';

describe('cleanCheckoutBranding', () => {
  it('accepts an https logo, a #rrggbb colour (lower-cased) and https / site-relative links', () => {
    expect(cleanCheckoutBranding({ logoUrl: ' https://cdn.example.com/l.png ', accentColor: '#AA00BB', footerLinks: [{ label: 'Refunds', url: '/policies/refund' }, { label: 'Help', url: 'https://example.com/help' }] }))
      .toEqual({ logoUrl: 'https://cdn.example.com/l.png', accentColor: '#aa00bb', footerLinks: [{ label: 'Refunds', url: '/policies/refund' }, { label: 'Help', url: 'https://example.com/help' }] });
  });
  it('clears with null or when everything is empty', () => {
    expect(cleanCheckoutBranding(null)).toBeNull();
    expect(cleanCheckoutBranding({ logoUrl: '', accentColor: '', footerLinks: [] })).toBeNull();
  });
  it('refuses unsafe or malformed values', () => {
    expect(() => cleanCheckoutBranding({ logoUrl: 'http://x.com/l.png' })).toThrow(/https/);
    expect(() => cleanCheckoutBranding({ logoUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => cleanCheckoutBranding({ logoUrl: 'https://user:pw@x.com/l.png' })).toThrow();
    expect(() => cleanCheckoutBranding({ accentColor: 'red' })).toThrow(/accent/);
    expect(() => cleanCheckoutBranding({ accentColor: '#fff' })).toThrow(/accent/);
    expect(() => cleanCheckoutBranding({ footerLinks: [{ label: 'x', url: 'javascript:alert(1)' }] })).toThrow(/Footer links/);
    expect(() => cleanCheckoutBranding({ footerLinks: [{ label: 'x', url: '//evil.com' }] })).toThrow(/Footer links/);
    expect(() => cleanCheckoutBranding({ footerLinks: [{ label: '', url: '/a' }] })).toThrow(/label/);
    expect(() => cleanCheckoutBranding({ footerLinks: Array.from({ length: 6 }, () => ({ label: 'a', url: '/a' })) })).toThrow(/At most 5/);
    expect(() => cleanCheckoutBranding('x')).toThrow();
    expect(() => cleanCheckoutBranding([])).toThrow();
  });
});
