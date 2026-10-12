import { CUSTOMER_EMAIL_CATALOG, CUSTOMER_EMAIL_EVENTS, CUSTOMER_EMAIL_SAMPLE_VARS, templateTags } from './customer-email-events';
import { renderBodyText, renderCustomerEmail, renderSubject, textToParagraphs } from './customer-email-template.util';

describe('customer email templates', () => {
  it('every built-in template only uses tags its event declares, and every tag has a sample value', () => {
    for (const key of CUSTOMER_EMAIL_EVENTS) {
      const def = CUSTOMER_EMAIL_CATALOG[key];
      for (const tag of [...templateTags(def.defaultSubject), ...templateTags(def.defaultBody)]) {
        expect(def.variables).toContain(tag);
      }
      for (const tag of def.variables) {
        if (tag === 'storeName') continue; // filled from the store itself
        expect(CUSTOMER_EMAIL_SAMPLE_VARS[tag]).toBeDefined();
      }
    }
  });

  it('replaces tags in the subject and keeps it on one line', () => {
    expect(renderSubject('Order #{{orderNumber}} from {{storeName}}', { orderNumber: '1001', storeName: 'First Store' })).toBe('Order #1001 from First Store');
    expect(renderSubject('Hi {{customerName}}', { customerName: 'A\nB' })).toBe('Hi A B');
  });

  it('drops a body line whose tag has no value (no dangling "Carrier:")', () => {
    const body = renderBodyText('Hello\n\nCarrier: {{carrier}}\nTracking: {{trackingNumber}}', { carrier: null, trackingNumber: 'T1' });
    expect(body).toBe('Hello\n\nTracking: T1');
  });

  it('treats an unknown tag as empty and drops its line', () => {
    expect(renderBodyText('A\nB {{nope}}\nC', {})).toBe('A\nC');
  });

  it('collapses the blank lines a dropped line leaves behind', () => {
    expect(renderBodyText('A\n\n{{x}}\n\nB', { x: '' })).toBe('A\n\nB');
  });

  it('escapes everything the seller or customer typed (no markup injection)', () => {
    const html = textToParagraphs('<script>alert(1)</script>\nline two');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<br>');
    const rendered = renderCustomerEmail({
      subjectTemplate: '{{customerName}}',
      bodyTemplate: 'Hi {{customerName}}',
      vars: { customerName: '<img src=x onerror=1>' },
      storeName: 'Shop <b>',
    });
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).not.toContain('Shop <b>');
  });

  it('brands the email as the store, not the platform', () => {
    const { html } = renderCustomerEmail({ subjectTemplate: 'S', bodyTemplate: 'B', vars: {}, storeName: 'First Store' });
    expect(html).toContain('First Store');
    expect(html).toContain('your order from First Store');
    expect(html).not.toContain('activity on your');
  });

  it('adds the call-to-action button only when there is a link', () => {
    const withCta = renderCustomerEmail({ subjectTemplate: 'S', bodyTemplate: 'B', vars: {}, storeName: 'X', cta: { label: 'View your order', url: 'https://x.test/o' } });
    const without = renderCustomerEmail({ subjectTemplate: 'S', bodyTemplate: 'B', vars: {}, storeName: 'X' });
    expect(withCta.html).toContain('https://x.test/o');
    expect(without.html).not.toContain('class="cta"');
  });
});
