'use strict';
const crypto = require('crypto');
const { V1, idempotencyKey } = require('../lib');

const freshKey = () => `zapier:${crypto.randomUUID()}`;

/** What is still to ship on each line: ordered, minus cancelled lines, minus what earlier shipments already took. */
function unshippedLines(order) {
  const shipped = {};
  for (const s of order.shipments || []) for (const i of s.items || []) shipped[i.line_item_id] = (shipped[i.line_item_id] || 0) + Number(i.quantity || 0);
  return (order.line_items || [])
    .filter((l) => !l.cancelled_at && l.type !== 'digital')
    .map((l) => ({ id: l.id, quantity: Number(l.quantity || 0) - (shipped[l.id] || 0) }))
    .filter((l) => l.quantity > 0);
}

const fulfilOrder = {
  key: 'fulfil_order', noun: 'Order',
  display: { label: 'Ship Order', description: 'Marks every item not shipped yet as shipped, with tracking. The buyer gets the shipping email unless you turn it off.' },
  operation: {
    inputFields: [
      { key: 'order_id', label: 'Order ID', required: true, helpText: 'The order\'s ID (the "ID" field of a Solvexo order trigger).' },
      { key: 'carrier', label: 'Courier', required: false, helpText: 'e.g. TCS, Leopards, DHL.' },
      { key: 'tracking_number', label: 'Tracking number', required: false },
      { key: 'tracking_url', label: 'Tracking link', required: false, helpText: 'Starts with https://' },
      { key: 'notify_customer', label: 'Email the buyer?', type: 'boolean', default: 'true', required: false },
    ],
    perform: async (z, bundle) => {
      const id = String(bundle.inputData.order_id).trim();
      const order = (await z.request({ url: `${V1()}/orders/${encodeURIComponent(id)}` })).data;
      const lines = unshippedLines(order);
      if (!lines.length) throw new z.errors.Error('Every item on this order has already been shipped (or cancelled).', 'NothingToShip', 400);
      const body = { line_items: lines, carrier: bundle.inputData.carrier || undefined, tracking_number: bundle.inputData.tracking_number || undefined, tracking_url: bundle.inputData.tracking_url || undefined, notify_customer: bundle.inputData.notify_customer !== false && bundle.inputData.notify_customer !== 'false' };
      // Keyed on what is being shipped: a retry of the same shipment is applied once (the same lines can't ship twice anyway).
      const r = await z.request({ url: `${V1()}/orders/${encodeURIComponent(id)}/fulfillments`, method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('fulfil', id, body) }, body });
      return r.data;
    },
    sample: { id: '6740c1f2a9b3c4d5e6f70812', order_number: 'SX-10234', status: 'shipped', shipments: [{ id: '6740c1f2a9b3c4d5e6f70900', items: [{ line_item_id: '6740c1f2a9b3c4d5e6f70813', quantity: 2 }], carrier: 'TCS', tracking_number: 'TCS123', tracking_url: null, shipped_at: '2026-11-24T11:00:00.000Z', delivered_at: null }] },
  },
};

const adjustStock = {
  key: 'adjust_stock', noun: 'Stock level',
  display: { label: 'Adjust Stock', description: 'Adds or removes stock for one product variant.' },
  operation: {
    inputFields: [
      { key: 'variant_id', label: 'Variant ID', required: true, helpText: 'From a product trigger (variants → ID) or the Stock Level Changed trigger.' },
      { key: 'delta', label: 'Change', type: 'integer', required: true, helpText: 'Units to add (e.g. 10) or remove (e.g. -3).' },
      { key: 'reason', label: 'Reason', required: false, choices: { restocked: 'Restocked', correction: 'Correction', other: 'Other' }, default: 'correction' },
      { key: 'note', label: 'Note', required: false },
    ],
    perform: async (z, bundle) => {
      const body = { variantId: String(bundle.inputData.variant_id).trim(), delta: Number(bundle.inputData.delta), reason: bundle.inputData.reason || 'correction', note: bundle.inputData.note || undefined };
      // A fresh key every run: two real sales of the same item must each take one off (the same body is not a repeat).
      return (await z.request({ url: `${V1()}/inventory/adjust`, method: 'POST', headers: { 'Idempotency-Key': freshKey() }, body })).data;
    },
    sample: { variantId: '6740c1f2a9b3c4d5e6f70701', delta: 10, reason: 'restocked', result: 'ok' },
  },
};

const updateProduct = {
  key: 'update_product', noun: 'Product',
  display: { label: 'Update Product', description: 'Shows or hides a product, or replaces its tags.' },
  operation: {
    inputFields: [
      { key: 'product_id', label: 'Product ID', required: true },
      { key: 'status', label: 'Status', required: false, choices: { active: 'Active (for sale)', inactive: 'Inactive (hidden)' } },
      { key: 'tags', label: 'Tags', list: true, required: false, helpText: 'Replaces all of the product\'s tags.' },
    ],
    perform: async (z, bundle) => {
      const id = String(bundle.inputData.product_id).trim();
      const body = {};
      if (bundle.inputData.status) body.status = bundle.inputData.status;
      if (bundle.inputData.tags !== undefined) body.tags = bundle.inputData.tags;
      if (!Object.keys(body).length) throw new z.errors.Error('Choose a status or tags to change.', 'NothingToChange', 400);
      return (await z.request({ url: `${V1()}/products/${encodeURIComponent(id)}`, method: 'PATCH', headers: { 'Idempotency-Key': freshKey() }, body })).data;
    },
    sample: { id: '6740c1f2a9b3c4d5e6f70700', name: 'Cotton kurta', status: 'inactive', tags: ['summer', 'sale'] },
  },
};

module.exports = { creates: [fulfilOrder, adjustStock, updateProduct], unshippedLines };
