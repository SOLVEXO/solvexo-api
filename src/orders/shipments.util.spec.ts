/* eslint-disable prettier/prettier, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { cleanTrackingInput, isFullyShipped, parseLabelItemsQuery, shippedQtyByItem, unshippedLines, validateFulfilRequest, validateReturnLabelItems } from './shipments.util';
import { buildReadyForPickupEmail, buildShippedEmail } from './shipping-email.util';
import { toBuyerSafeOrder } from '@/common/buyer-safe-order.util';

const items = [
  { _id: 'a', type: 'physical', quantity: 3, status: 'processing' },
  { _id: 'b', type: 'physical', quantity: 1, status: 'processing' },
  { _id: 'c', type: 'physical', quantity: 2, status: 'cancelled' },
  { _id: 'd', type: 'digital', quantity: 1, status: 'processing' },
];

describe('shipments.util', () => {
  it('sums shipped quantities per item across shipments', () => {
    const m = shippedQtyByItem([{ items: [{ itemId: 'a', quantity: 1 }] }, { items: [{ itemId: 'a', quantity: 2 }, { itemId: 'b', quantity: 1 }] }]);
    expect(m.get('a')).toBe(3);
    expect(m.get('b')).toBe(1);
  });

  it('unshippedLines skips cancelled and digital lines and subtracts shipped units', () => {
    const lines = unshippedLines(items, [{ items: [{ itemId: 'a', quantity: 1 }] }]);
    expect(lines.map((l) => [l.itemId, l.quantity])).toEqual([['a', 2], ['b', 1]]);
  });

  it('accepts a partial request and reports not-all-shipped', () => {
    const r = validateFulfilRequest(items, [], [{ itemId: 'a', quantity: 2 }]);
    expect(r).toEqual({ ok: true, lines: [{ itemIndex: 0, itemId: 'a', quantity: 2 }], allShipped: false });
  });

  it('reports allShipped when the last units ship (cancelled lines ignored)', () => {
    const r = validateFulfilRequest(items, [{ items: [{ itemId: 'a', quantity: 2 }] }], [{ itemId: 'a', quantity: 1 }, { itemId: 'b', quantity: 1 }]);
    expect(r.ok && r.allShipped).toBe(true);
  });

  it.each([
    [[], /at least one/],
    [[{ itemId: 'a', quantity: 4 }], /Only 3/],
    [[{ itemId: 'a', quantity: 0 }], /whole number/],
    [[{ itemId: 'a', quantity: 1.5 }], /whole number/],
    [[{ itemId: 'c', quantity: 1 }], /cancelled/],
    [[{ itemId: 'd', quantity: 1 }], /physical/],
    [[{ itemId: 'zzz', quantity: 1 }], /does not belong/],
    [[{ itemId: 'a', quantity: 1 }, { itemId: 'a', quantity: 1 }], /only once/],
  ])('rejects invalid request %#', (req: any, msg: RegExp) => {
    const r = validateFulfilRequest(items, [], req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });

  it('rejects shipping units that an earlier shipment already covered', () => {
    const r = validateFulfilRequest(items, [{ items: [{ itemId: 'b', quantity: 1 }] }], [{ itemId: 'b', quantity: 1 }]);
    expect(r.ok).toBe(false);
  });

  it('isFullyShipped is false with nothing shippable and true once every unit is covered', () => {
    expect(isFullyShipped([{ _id: 'x', type: 'digital', quantity: 1 }], [])).toBe(false);
    expect(isFullyShipped(items, [{ items: [{ itemId: 'a', quantity: 3 }, { itemId: 'b', quantity: 1 }] }])).toBe(true);
    expect(isFullyShipped(items, [{ items: [{ itemId: 'a', quantity: 3 }] }])).toBe(false);
  });

  it('cleanTrackingInput trims, drops non-http urls and returns null when empty', () => {
    expect(cleanTrackingInput({ carrier: ' DHL ', trackingNumber: '1', trackingUrl: 'javascript:alert(1)' })).toEqual({ carrier: 'DHL', trackingNumber: '1', trackingUrl: null });
    expect(cleanTrackingInput({ carrier: '', trackingNumber: '  ' })).toBeNull();
    expect(cleanTrackingInput(undefined)).toBeNull();
  });
});

describe('shipping emails + buyer-safe order', () => {
  it('shipped email carries carrier, tracking number and link, and escapes HTML', () => {
    const e = buildShippedEmail({ storeName: '<b>Shop</b>', orderNumber: 'ORD1', tracking: { carrier: 'DHL', trackingNumber: 'T123', trackingUrl: 'https://t.example/T123' } });
    expect(e.html).toContain('DHL');
    expect(e.html).toContain('T123');
    expect(e.html).toContain('https://t.example/T123');
    expect(e.html).not.toContain('<b>Shop</b>');
  });

  it('ready-for-pickup email carries the address and instructions', () => {
    const e = buildReadyForPickupEmail({ storeName: 'Shop', orderNumber: 'O2', pickup: { name: 'Main', address: '1 Road', instructions: 'Ask at desk' } });
    expect(e.html).toContain('1 Road');
    expect(e.html).toContain('Ask at desk');
  });

  it('toBuyerSafeOrder keeps pickup fields and strips label data from shipments', () => {
    const safe = toBuyerSafeOrder({
      fulfillmentMethod: 'pickup', pickupLocation: { name: 'Main' },
      sellerOrders: [{ items: [], shipments: [{ tracking: { carrier: 'DHL', labelUrl: 'https://secret' } }] }],
    });
    expect(safe.fulfillmentMethod).toBe('pickup');
    expect(safe.pickupLocation).toEqual({ name: 'Main' });
    expect(safe.sellerOrders[0].shipments[0].tracking).toEqual({ carrier: 'DHL', trackingNumber: null, trackingUrl: null });
  });
});

describe('partial-shipment label helpers', () => {
  const A = 'a'.repeat(24);
  const B = 'b'.repeat(24);

  it('parses "itemId:qty,itemId:qty"', () => {
    expect(parseLabelItemsQuery(`${A}:2,${B}:1`)).toEqual([{ itemId: A, quantity: 2 }, { itemId: B, quantity: 1 }]);
  });

  it('rejects malformed item queries', () => {
    expect(parseLabelItemsQuery(undefined)).toBeNull();
    expect(parseLabelItemsQuery('')).toBeNull();
    expect(parseLabelItemsQuery('not-an-id:1')).toBeNull();
    expect(parseLabelItemsQuery(`${A}:0`)).toBeNull();
    expect(parseLabelItemsQuery(`${A}:1.5`)).toBeNull();
    expect(parseLabelItemsQuery(`${A}`)).toBeNull();
  });
});

describe('validateReturnLabelItems', () => {
  const lines = [
    { _id: 'a', type: 'physical', quantity: 1, returnStatus: 'approved' },
    { _id: 'b', type: 'physical', quantity: 1, returnStatus: 'requested' },
    { _id: 'c', type: 'physical', quantity: 1, returnStatus: 'approved', returnLabel: { labelUrl: 'x' } },
    { _id: 'd', type: 'digital', quantity: 1, returnStatus: 'approved' },
  ];

  it('accepts approved physical lines without a label', () => {
    expect(validateReturnLabelItems(lines, ['a'])).toEqual({ ok: true, indexes: [0] });
  });

  it('rejects unapproved, already-labelled, digital, unknown and duplicate lines', () => {
    expect(validateReturnLabelItems(lines, ['b']).ok).toBe(false);
    expect(validateReturnLabelItems(lines, ['c']).ok).toBe(false);
    expect(validateReturnLabelItems(lines, ['d']).ok).toBe(false);
    expect(validateReturnLabelItems(lines, ['zzz']).ok).toBe(false);
    expect(validateReturnLabelItems(lines, ['a', 'a']).ok).toBe(false);
    expect(validateReturnLabelItems(lines, []).ok).toBe(false);
  });
});

describe('buyer-safe return label', () => {
  it('exposes only the link + tracking to the buyer, never cost or rate id', () => {
    const safe = toBuyerSafeOrder({
      sellerOrders: [{
        items: [{ _id: 'a', returnLabel: { labelUrl: 'https://l', trackingNumber: 'T1', carrier: 'UPS', cost: 7.5, currency: 'USD', rateId: 'r1', purchasedAt: 'now' } }],
        shipments: [{ _id: 's', items: [], tracking: { carrier: 'UPS', trackingNumber: 'T2', trackingUrl: null, labelUrl: 'https://secret', labelCost: 5 } }],
      }],
    });
    const rl = safe.sellerOrders[0].items[0].returnLabel;
    expect(rl).toEqual({ labelUrl: 'https://l', trackingNumber: 'T1', trackingUrl: null, carrier: 'UPS', purchasedAt: 'now' });
    expect(rl.cost).toBeUndefined();
    expect(rl.rateId).toBeUndefined();
    expect(safe.sellerOrders[0].shipments[0].tracking.labelUrl).toBeUndefined();
  });
});
