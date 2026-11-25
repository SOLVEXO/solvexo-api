'use strict';
const { V1 } = require('../lib');

/**
 * An instant trigger on a Solvexo webhook event (REST hook):
 *   - turning the Zap on subscribes  (POST /webhooks, owned by this connection's token),
 *   - turning it off unsubscribes    (DELETE /webhooks/:id),
 *   - an event arrives as { id, event, created_at, store_id, data } and is turned into the full record (`load`), so
 *     the Zap sees the same fields as in the sample Zapier shows while setting it up (`list`).
 * `dedupe` makes each event unique (an order that is paid, then shipped, fires two different triggers).
 */
function hookTrigger({ key, noun, label, description, event, load, list, sample }) {
  return {
    key, noun,
    display: { label, description },
    operation: {
      type: 'hook',
      performSubscribe: async (z, bundle) => {
        const r = await z.request({ url: `${V1()}/webhooks`, method: 'POST', body: { url: bundle.targetUrl, events: [event], description: `Zapier: ${label}` } });
        return r.data;
      },
      performUnsubscribe: async (z, bundle) => {
        const r = await z.request({ url: `${V1()}/webhooks/${bundle.subscribeData.id}`, method: 'DELETE', skipThrowForStatus: true });
        // Already gone (e.g. the store removed it): nothing left to undo.
        if (r.status === 404) return {};
        return r.data;
      },
      perform: async (z, bundle) => {
        const body = bundle.cleanedRequest || {};
        if (body.event && body.event !== event) return [];
        const record = await load(z, bundle, body.data || {});
        return record ? [{ ...record, id: body.id || record.id, record_id: record.id, event_at: body.created_at || null }] : [];
      },
      performList: async (z, bundle) => (await list(z, bundle)).map((r) => ({ ...r, record_id: r.id, event_at: r.updated_at || r.created_at || null })),
      sample: { ...sample, record_id: sample.id, event_at: '2026-11-24T10:00:00.000Z' },
    },
  };
}

const getJson = async (z, url, params) => (await z.request({ url, params })).data;
const orderById = (z, id) => getJson(z, `${V1()}/orders/${encodeURIComponent(id)}`);
const recentOrders = async (z, params = {}) => (await getJson(z, `${V1()}/orders`, { limit: 3, ...params })).items;

const ORDER_SAMPLE = {
  id: '6740c1f2a9b3c4d5e6f70812', order_number: 'SX-10234', created_at: '2026-11-24T09:58:00.000Z', updated_at: '2026-11-24T10:00:00.000Z',
  currency: 'PKR', status: 'processing', return_status: 'none', paid: true, paid_at: '2026-11-24T09:59:00.000Z', payment_status: 'paid', payment_method: 'Card',
  fulfillment_method: 'ship', customer_id: '6740c1f2a9b3c4d5e6f70001',
  shipping_address: { name: 'Ayesha Khan', phone: '03001234567', address1: '12 Main Boulevard', address2: null, city: 'Lahore', province: 'Punjab', zip: '54000', country: 'PK' },
  line_items: [{ id: '6740c1f2a9b3c4d5e6f70813', product_id: '6740c1f2a9b3c4d5e6f70700', variant_id: '6740c1f2a9b3c4d5e6f70701', name: 'Cotton kurta', sku: 'KURTA-M', type: 'physical', options: [{ name: 'Size', value: 'M' }], quantity: 2, price: 2500, total: 5000, cancelled_at: null, refunded_amount: 0 }],
  subtotal: 5000, tax: 0, refunded_total: 0, shipping: 250, discount_code: null, total: 5250, shipments: [], shipped_at: null, delivered_at: null, cancelled_at: null, cancel_reason: null,
};

const orderTrigger = (key, event, label, description, listParams) => hookTrigger({
  key, noun: 'Order', label, description, event,
  load: (z, bundle, data) => orderById(z, data.order_id),
  list: (z) => recentOrders(z, listParams),
  sample: ORDER_SAMPLE,
});

const CUSTOMER_SAMPLE = { id: '6740c1f2a9b3c4d5e6f70001', name: 'Ayesha Khan', email: 'ayesha@example.com', phone: '03001234567', guest: false, tags: ['vip'], email_marketing: true, sms_marketing: false, whatsapp_marketing: false, erased: false, created_at: '2026-11-20T08:00:00.000Z', updated_at: '2026-11-24T10:00:00.000Z' };
const PRODUCT_SAMPLE = { id: '6740c1f2a9b3c4d5e6f70700', name: 'Cotton kurta', slug: 'cotton-kurta', status: 'active', type: 'physical', description: '', short_description: '', vendor: null, tags: ['summer'], images: [], category_id: null, variants: [{ id: '6740c1f2a9b3c4d5e6f70701', sku: 'KURTA-M', barcode: null, options: [{ name: 'Size', value: 'M' }], price: 2500, compare_at_price: null, currency: 'PKR', inventory: { tracked: true, on_hand: 20, committed: 2, available: 18, allow_backorder: false }, taxable: true, weight: null, images: [], updated_at: '2026-11-24T10:00:00.000Z' }], created_at: '2026-11-01T08:00:00.000Z', updated_at: '2026-11-24T10:00:00.000Z' };
const STOCK_SAMPLE = { id: '6740c1f2a9b3c4d5e6f70701', variant_id: '6740c1f2a9b3c4d5e6f70701', product_id: '6740c1f2a9b3c4d5e6f70700', sku: 'KURTA-M', tracked: true, on_hand: 20, committed: 2, available: 18, allow_backorder: false, updated_at: '2026-11-24T10:00:00.000Z' };
const FORM_SAMPLE = { id: '6740c1f2a9b3c4d5e6f70900', message_id: '6740c1f2a9b3c4d5e6f70900', form_name: 'Contact us', name: 'Bilal Ahmed', email: 'bilal@example.com', phone: '03211234567', message: 'Do you deliver to Karachi?', fields: [{ label: 'City', type: 'text', value: 'Karachi' }], submitted_at: '2026-11-24T10:00:00.000Z' };

module.exports = [
  orderTrigger('new_order', 'order.created', 'New Order', 'Triggers when a new order is placed in your store.'),
  orderTrigger('order_paid', 'order.paid', 'Order Paid', 'Triggers when an order is paid.', { paid: 'true' }),
  orderTrigger('order_fulfilled', 'order.fulfilled', 'Order Shipped', 'Triggers when an order is shipped or delivered.', { status: 'shipped' }),
  orderTrigger('order_cancelled', 'order.cancelled', 'Order Cancelled', 'Triggers when an order is cancelled.', { status: 'cancelled' }),
  orderTrigger('refund_created', 'refund.created', 'Order Refunded', 'Triggers when an order is fully or partly refunded.'),
  hookTrigger({
    key: 'new_customer', noun: 'Customer', label: 'New Customer', description: 'Triggers when a shopper creates an account in your store.', event: 'customer.created',
    load: (z, bundle, data) => getJson(z, `${V1()}/customers/${encodeURIComponent(data.customer_id)}`),
    list: async (z) => (await getJson(z, `${V1()}/customers`, { limit: 3 })).items,
    sample: CUSTOMER_SAMPLE,
  }),
  hookTrigger({
    key: 'product_updated', noun: 'Product', label: 'Product Created or Updated', description: 'Triggers when a product is added or changed (name, price, status, images…).', event: 'product.updated',
    load: async (z, bundle, data) => {
      // A deleted product can't be read any more: pass on what the event says.
      const r = await z.request({ url: `${V1()}/products/${encodeURIComponent(data.product_id)}`, skipThrowForStatus: true });
      if (r.status === 404) return { id: data.product_id, name: data.name, slug: data.slug, status: data.status, deleted: true };
      if (r.status >= 400) r.throwForStatus();
      return { ...r.data, deleted: false };
    },
    list: async (z) => (await getJson(z, `${V1()}/products`, { limit: 3 })).items.map((p) => ({ ...p, deleted: false })),
    sample: { ...PRODUCT_SAMPLE, deleted: false },
  }),
  hookTrigger({
    key: 'stock_changed', noun: 'Stock level', label: 'Stock Level Changed', description: 'Triggers when the stock of a product variant changes (sales, returns, adjustments).', event: 'inventory.changed',
    load: async (z, bundle, data) => ({ id: data.variant_id, variant_id: data.variant_id, product_id: data.product_id, sku: data.sku, tracked: data.available !== null, on_hand: data.on_hand, committed: data.committed, available: data.available }),
    list: async (z) => (await getJson(z, `${V1()}/inventory`, { limit: 3 })).items.map((v) => ({ ...v, id: v.variant_id })),
    sample: STOCK_SAMPLE,
  }),
  hookTrigger({
    key: 'form_submitted', noun: 'Form submission', label: 'New Form Submission', description: 'Triggers when someone sends a form on your store (Contact us and custom forms).', event: 'form.submitted',
    load: async (z, bundle, data) => ({ ...data, id: data.message_id }),
    // Form messages aren't in the API: Zapier shows this sample while you set the Zap up.
    list: async () => [FORM_SAMPLE],
    sample: FORM_SAMPLE,
  }),
];
