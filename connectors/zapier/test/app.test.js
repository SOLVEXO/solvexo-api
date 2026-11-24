'use strict';
const nock = require('nock');
const zapier = require('zapier-platform-core');
// What `zapier validate` checks: the app after its functions are compiled.
const { compileApp, validateApp } = require('zapier-platform-core/src/tools/schema');
const App = require('../index');
const { unshippedLines } = require('../creates');

const appTester = zapier.createAppTester(App);
zapier.tools.env.inject();
const API = 'https://api.solvexo.store';
const V1 = `${API}/api/merchant/v1`;
const authData = { access_token: 'sxk_test' };
const ORDER = {
  id: 'o1', order_number: 'SX-1', status: 'processing', currency: 'PKR',
  line_items: [{ id: 'l1', quantity: 2, type: 'physical' }, { id: 'l2', quantity: 1, type: 'physical' }, { id: 'l3', quantity: 1, type: 'physical', cancelled_at: '2026-11-24T00:00:00Z' }, { id: 'l4', quantity: 1, type: 'digital' }],
  shipments: [{ id: 's1', items: [{ line_item_id: 'l1', quantity: 1 }] }],
};

beforeAll(() => { process.env.CLIENT_ID = 'app_test'; process.env.CLIENT_SECRET = 'appsec_test'; nock.disableNetConnect(); });
afterEach(() => { expect(nock.isDone()).toBe(true); nock.cleanAll(); });

describe('app definition', () => {
  it('passes Zapier\'s own schema validation', () => {
    expect(validateApp(compileApp(App))).toEqual([]);
  });
  it('signs in with Solvexo OAuth: the fixed authorize address, form-encoded code swap, no refresh', () => {
    const o = App.authentication.oauth2Config;
    expect(App.authentication.type).toBe('oauth2');
    expect(o.authorizeUrl.url).toBe('https://www.solvexo.store/oauth/authorize');
    expect(o.getAccessToken).toMatchObject({ url: `${API}/api/app-platform/oauth/token`, method: 'POST', body: { grant_type: 'authorization_code' } });
    expect(o.getAccessToken.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(o.autoRefresh).toBe(false);
  });
});

describe('auth test', () => {
  it('reads the store and sends the token', async () => {
    nock(V1, { reqheaders: { authorization: 'Bearer sxk_test' } }).get('/store').reply(200, { id: 's1', name: 'Khan Fabrics' });
    const r = await appTester(App.authentication.test, { authData });
    expect(r.name).toBe('Khan Fabrics');
  });
  it('a removed app asks the user to reconnect', async () => {
    nock(V1).get('/store').reply(401, { statusCode: 401, message: 'Invalid API token' });
    await expect(appTester(App.authentication.test, { authData })).rejects.toThrow(/Reconnect your Solvexo account/);
  });
});

describe('instant triggers', () => {
  const t = App.triggers.order_paid.operation;
  it('turning the Zap on subscribes to just its event; off unsubscribes (a webhook already gone is fine)', async () => {
    nock(V1).post('/webhooks', (b) => b.url === 'https://hooks.zapier.com/abc' && JSON.stringify(b.events) === '["order.paid"]').reply(200, { id: 'w1', url: 'https://hooks.zapier.com/abc', events: ['order.paid'], secret: 'whsec_x' });
    const sub = await appTester(t.performSubscribe, { authData, targetUrl: 'https://hooks.zapier.com/abc' });
    expect(sub.id).toBe('w1');
    nock(V1).delete('/webhooks/w1').reply(200, { success: true });
    await appTester(t.performUnsubscribe, { authData, subscribeData: { id: 'w1' } });
    nock(V1).delete('/webhooks/w2').reply(404, { message: 'Webhook not found' });
    await expect(appTester(t.performUnsubscribe, { authData, subscribeData: { id: 'w2' } })).resolves.toEqual({});
  });
  it('an event becomes the full order, unique per event', async () => {
    nock(V1).get('/orders/o1').reply(200, ORDER);
    const out = await appTester(t.perform, { authData, cleanedRequest: { id: 'order.paid:o1', event: 'order.paid', created_at: '2026-11-24T10:00:00Z', store_id: 's1', data: { order_id: 'o1' } } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'order.paid:o1', record_id: 'o1', order_number: 'SX-1', event_at: '2026-11-24T10:00:00Z' });
  });
  it('another event delivered by mistake is ignored', async () => {
    expect(await appTester(t.perform, { authData, cleanedRequest: { id: 'x', event: 'order.created', data: { order_id: 'o1' } } })).toEqual([]);
  });
  it('the sample while setting up comes from recent paid orders, same fields', async () => {
    nock(V1).get('/orders').query({ limit: 3, paid: 'true' }).reply(200, { items: [ORDER], has_more: false, next_cursor: null });
    const out = await appTester(t.performList, { authData });
    expect(out[0]).toMatchObject({ id: 'o1', record_id: 'o1', order_number: 'SX-1' });
  });
  it('a deleted product still triggers, with what the event knew', async () => {
    nock(V1).get('/products/p9').reply(404, { message: 'Product not found' });
    const out = await appTester(App.triggers.product_updated.operation.perform, { authData, cleanedRequest: { id: 'e1', event: 'product.updated', data: { product_id: 'p9', name: 'Old kurta', slug: 'old', status: 'inactive', deleted: true } } });
    expect(out[0]).toMatchObject({ record_id: 'p9', name: 'Old kurta', deleted: true });
  });
});

describe('actions', () => {
  it('works out what is still to ship: minus shipped, cancelled and digital lines', () => {
    expect(unshippedLines(ORDER)).toEqual([{ id: 'l1', quantity: 1 }, { id: 'l2', quantity: 1 }]);
  });
  it('Ship Order sends those lines with tracking and an Idempotency-Key', async () => {
    nock(V1).get('/orders/o1').reply(200, ORDER);
    nock(V1, { reqheaders: { 'idempotency-key': /^zapier:[0-9a-f]{40}$/ } })
      .post('/orders/o1/fulfillments', { line_items: [{ id: 'l1', quantity: 1 }, { id: 'l2', quantity: 1 }], carrier: 'TCS', tracking_number: 'T1', notify_customer: true })
      .reply(200, { ...ORDER, status: 'shipped' });
    const r = await appTester(App.creates.fulfil_order.operation.perform, { authData, inputData: { order_id: 'o1', carrier: 'TCS', tracking_number: 'T1' } });
    expect(r.status).toBe('shipped');
  });
  it('Ship Order on a fully shipped order says so instead of calling the API', async () => {
    nock(V1).get('/orders/o2').reply(200, { ...ORDER, id: 'o2', shipments: [{ items: [{ line_item_id: 'l1', quantity: 2 }, { line_item_id: 'l2', quantity: 1 }] }] });
    await expect(appTester(App.creates.fulfil_order.operation.perform, { authData, inputData: { order_id: 'o2' } })).rejects.toThrow(/already been shipped/);
  });
  it('Adjust Stock uses a fresh key each run, so two real sales each count', async () => {
    const keys = [];
    nock(V1).post('/inventory/adjust').times(2).reply(function () { keys.push(this.req.headers['idempotency-key']); return [200, { result: 'ok' }]; });
    const input = { authData, inputData: { variant_id: 'v1', delta: -1 } };
    await appTester(App.creates.adjust_stock.operation.perform, input);
    await appTester(App.creates.adjust_stock.operation.perform, input);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('Update Product needs something to change; a 403 explains the missing permission', async () => {
    await expect(appTester(App.creates.update_product.operation.perform, { authData, inputData: { product_id: 'p1' } })).rejects.toThrow(/Choose a status or tags/);
    nock(V1).patch('/products/p1').reply(403, { statusCode: 403, message: 'This token does not have the "write_products" permission' });
    await expect(appTester(App.creates.update_product.operation.perform, { authData, inputData: { product_id: 'p1', status: 'inactive' } })).rejects.toThrow(/write_products/);
  });
});
