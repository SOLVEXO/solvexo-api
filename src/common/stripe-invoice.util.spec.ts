/* eslint-disable prettier/prettier */
import { getInvoicePaymentIntentId, getInvoiceSubscriptionId } from './stripe-invoice.util';

/**
 * Stripe API 2025-03-31.basil removed `invoice.subscription` and
 * `invoice.payment_intent`. These fixtures mirror both payload shapes, because
 * a webhook event's shape depends on the endpoint/account API version.
 */
describe('stripe-invoice.util', () => {
  describe('getInvoiceSubscriptionId', () => {
    it('reads the legacy string field (pre-Basil)', () => {
      expect(getInvoiceSubscriptionId({ id: 'in_1', subscription: 'sub_legacy' })).toBe('sub_legacy');
    });

    it('reads a legacy expanded object', () => {
      expect(getInvoiceSubscriptionId({ subscription: { id: 'sub_obj' } })).toBe('sub_obj');
    });

    it('reads parent.subscription_details.subscription (Basil+)', () => {
      const invoice = { id: 'in_2', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_basil' } } };
      expect(getInvoiceSubscriptionId(invoice)).toBe('sub_basil');
    });

    it('reads an expanded Basil+ subscription object', () => {
      const invoice = { parent: { subscription_details: { subscription: { id: 'sub_basil_obj' } } } };
      expect(getInvoiceSubscriptionId(invoice)).toBe('sub_basil_obj');
    });

    it('falls back to the first line item parent (Basil+)', () => {
      const invoice = { lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_line' } } }] } };
      expect(getInvoiceSubscriptionId(invoice)).toBe('sub_line');
    });

    it('prefers the legacy field when both are present', () => {
      const invoice = { subscription: 'sub_legacy', parent: { subscription_details: { subscription: 'sub_new' } } };
      expect(getInvoiceSubscriptionId(invoice)).toBe('sub_legacy');
    });

    it.each([
      ['a one-off invoice', { id: 'in_3', subscription: null, parent: null }],
      ['a quote-generated invoice', { parent: { type: 'quote_details', quote_details: { quote: 'qt_1' } } }],
      ['an empty object', {}],
      ['null', null],
      ['undefined', undefined],
    ])('returns undefined for %s', (_label, invoice) => {
      expect(getInvoiceSubscriptionId(invoice)).toBeUndefined();
    });
  });

  describe('getInvoicePaymentIntentId', () => {
    it('reads the legacy string field', () => {
      expect(getInvoicePaymentIntentId({ payment_intent: 'pi_legacy' })).toBe('pi_legacy');
    });

    it('reads a legacy expanded object', () => {
      expect(getInvoicePaymentIntentId({ payment_intent: { id: 'pi_obj' } })).toBe('pi_obj');
    });

    it('reads it from the Basil+ payments list when expanded', () => {
      const invoice = { payments: { data: [{ payment: { type: 'charge', charge: 'ch_1' } }, { payment: { type: 'payment_intent', payment_intent: 'pi_new' } }] } };
      expect(getInvoicePaymentIntentId(invoice)).toBe('pi_new');
    });

    it('returns null (not throw) when a Basil+ event does not carry payments', () => {
      expect(getInvoicePaymentIntentId({ id: 'in_4', parent: { subscription_details: { subscription: 'sub_1' } } })).toBeNull();
    });

    it.each([[{}], [null], [undefined], [{ payments: { data: 'not-an-array' } }]])('returns null for %p', (invoice) => {
      expect(getInvoicePaymentIntentId(invoice as any)).toBeNull();
    });
  });
});
