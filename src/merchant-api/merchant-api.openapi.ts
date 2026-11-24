/* eslint-disable prettier/prettier */
import { API_PUBLIC_ORIGIN } from '../common/api-origin';
import { API_SCOPES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, WEBHOOK_EVENTS } from './merchant-api.util';
import { API_RATE_LIMIT_PER_MIN } from './api-tokens.service';

/**
 * The public description of the Solvexo Admin API (v1), served at GET /api/merchant/v1/openapi.json and rendered by
 * the developer docs page. Hand-written on purpose: it is the contract partners build against, so it only lists
 * fields the serializers in api-reads.service.ts actually return. Change both together (merchant-api.openapi.spec.ts
 * checks every route of the v1 controller is described here).
 */
export const API_VERSION = '1.0.0';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra });
const dt = { type: ['string', 'null'], format: 'date-time' };
const id = { type: 'string', description: '24-character id', example: '6740c1f2a9b3c4d5e6f70812' };
const money = (description: string) => ({ type: ['number', 'null'], description: `${description} In the order's \`currency\`, in major units (e.g. 1250.5).` });

const listParams = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }, description: 'Records per page.' },
  { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'The `next_cursor` of the previous page. Omit for the first page.' },
  { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Only records changed at or after this time (ISO 8601). Use it to sync changes since your last run.' },
];
const idParam = (what: string) => ({ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: `The ${what} id.` });
const idemHeader = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' }, description: 'A unique key per change (e.g. a UUID). Retrying with the same key and body returns the first answer (header `Idempotent-Replayed: true`) and never applies the change twice.' };

const page = (item: string) => ({
  type: 'object', required: ['items', 'has_more', 'next_cursor'],
  properties: { items: { type: 'array', items: ref(item) }, has_more: { type: 'boolean' }, next_cursor: { type: ['string', 'null'], description: 'Pass as `cursor` to get the next page; null on the last page.' } },
});
const errors = {
  '400': { description: 'The request is invalid. `message` says what to fix.', content: { 'application/json': { schema: ref('Error') } } },
  '401': { description: 'The token is missing, malformed, revoked or unknown.', content: { 'application/json': { schema: ref('Error') } } },
  '403': { description: 'The token does not have the permission (scope) this endpoint needs.', content: { 'application/json': { schema: ref('Error') } } },
  '429': { description: `More than ${API_RATE_LIMIT_PER_MIN} requests in a minute for this token. Wait \`Retry-After\` seconds.`, content: { 'application/json': { schema: ref('Error') } } },
};
const notFound = { '404': { description: 'Not found in this store.', content: { 'application/json': { schema: ref('Error') } } } };
const ok = (schema: unknown, description = 'OK') => ({ '200': { description, content: { 'application/json': { schema } } } });
const scope = (s: string) => ({ 'x-required-scope': s, security: [{ bearer: [s] }] });

export function buildOpenApiSpec(serverUrl: string = API_PUBLIC_ORIGIN) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Solvexo Admin API',
      version: API_VERSION,
      summary: 'Read and update a Solvexo store: orders, products, inventory, collections and customers.',
      description: [
        'The Solvexo Admin API lets your app work with one Solvexo store.',
        '',
        '**Authentication.** Send `Authorization: Bearer sxk_…`. A store owner creates a token in *Settings → API & webhooks* and picks its permissions (scopes); apps get the same kind of token through the OAuth app flow. A token only ever sees its own store.',
        '',
        `**Paging.** Lists return newest first, \`limit\` records at a time (default ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}), as \`{ items, has_more, next_cursor }\`. Pass \`next_cursor\` back as \`cursor\` for the next page. To sync, remember when you last ran and send \`updated_since\`.`,
        '',
        `**Rate limits.** ${API_RATE_LIMIT_PER_MIN} requests a minute per token. Every answer carries \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` and \`X-RateLimit-Reset\` (seconds); a 429 also carries \`Retry-After\`.`,
        '',
        '**Writes** need a `write_*` scope (which includes the matching `read_*`) and an `Idempotency-Key` header.',
        '',
        '**Money** is in major units of the record\'s currency (an order\'s `currency`, a variant\'s `currency`).',
        '',
        '**Webhooks.** Instead of polling, subscribe to events in *Settings → API & webhooks*. Each delivery is a POST with headers `X-Solvexo-Event`, `X-Solvexo-Delivery` (unique id; use it to ignore repeats) and `X-Solvexo-Signature: t=<unix seconds>,v1=<hex>`, where v1 is HMAC-SHA256 of `"<t>.<raw body>"` with your webhook secret. Reject a signature older than 5 minutes. Answer 2xx within 10 seconds; failures are retried after 1 min, 5 min, 30 min, 2 h and 6 h.',
      ].join('\n'),
      contact: { name: 'Solvexo developer support', email: 'sales@solvexo.store', url: 'https://www.solvexo.store/developers' },
      termsOfService: 'https://www.solvexo.store/terms',
    },
    servers: [{ url: `${serverUrl}/api/merchant/v1` }],
    security: [{ bearer: [] }],
    tags: [
      { name: 'Store' }, { name: 'Orders' }, { name: 'Products' }, { name: 'Inventory' }, { name: 'Collections' }, { name: 'Customers' },
    ],
    paths: {
      '/store': { get: { tags: ['Store'], operationId: 'getStore', summary: 'The store this token belongs to', description: 'Any valid token can call this; use it to check a token and read the store currency.', responses: { ...ok(ref('Store')), ...errors } } },
      '/orders': {
        get: {
          tags: ['Orders'], operationId: 'listOrders', summary: 'List orders', ...scope('read_orders'),
          description: 'This store\'s orders. On a marketplace order that includes other sellers, only this store\'s lines and amounts are returned.',
          parameters: [...listParams,
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded', 'partially_cancelled', 'partially_refunded', 'partially_shipped'] } },
            { name: 'paid', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
          responses: { ...ok(page('Order')), ...errors },
        },
      },
      '/orders/{id}': { get: { tags: ['Orders'], operationId: 'getOrder', summary: 'Get an order', ...scope('read_orders'), parameters: [idParam('order')], responses: { ...ok(ref('Order')), ...errors, ...notFound } } },
      '/orders/{id}/fulfillments': {
        post: {
          tags: ['Orders'], operationId: 'fulfilOrder', summary: 'Ship order lines', ...scope('write_orders'),
          description: 'Marks some or all unshipped lines as shipped, with optional tracking, exactly as the dashboard does (stock, buyer email, status). Pickup orders and cash-on-delivery orders that are not yet confirmed are refused with 400.',
          parameters: [idParam('order'), idemHeader],
          requestBody: { required: true, content: { 'application/json': { schema: ref('FulfillmentInput') } } },
          responses: { ...ok(ref('Order'), 'The updated order'), ...errors, ...notFound },
        },
      },
      '/products': {
        get: {
          tags: ['Products'], operationId: 'listProducts', summary: 'List products', ...scope('read_products'),
          parameters: [...listParams, { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'inactive', 'draft', 'scheduled'] } }],
          responses: { ...ok(page('Product')), ...errors },
        },
      },
      '/products/{id}': {
        get: { tags: ['Products'], operationId: 'getProduct', summary: 'Get a product with its variants', ...scope('read_products'), parameters: [idParam('product')], responses: { ...ok(ref('Product')), ...errors, ...notFound } },
        patch: {
          tags: ['Products'], operationId: 'updateProduct', summary: 'Change a product\'s status or tags', ...scope('write_products'),
          parameters: [idParam('product'), idemHeader],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: { status: { type: 'string', enum: ['active', 'inactive'] }, tags: { type: 'array', maxItems: 250, items: { type: 'string', maxLength: 255 } } } } } } },
          responses: { ...ok({ type: 'object', properties: { id, name: { type: 'string' }, status: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } }), ...errors, ...notFound },
        },
      },
      '/collections': { get: { tags: ['Collections'], operationId: 'listCollections', summary: 'List collections', ...scope('read_products'), parameters: listParams, responses: { ...ok(page('Collection')), ...errors } } },
      '/inventory': {
        get: {
          tags: ['Inventory'], operationId: 'listInventory', summary: 'Stock levels per variant', ...scope('read_inventory'),
          parameters: [...listParams, { name: 'product_id', in: 'query', schema: { type: 'string' }, description: 'Only this product\'s variants.' }],
          responses: { ...ok(page('InventoryLevel')), ...errors, ...notFound },
        },
      },
      '/inventory/adjust': {
        post: {
          tags: ['Inventory'], operationId: 'adjustInventory', summary: 'Add or remove stock for a variant', ...scope('write_inventory'),
          parameters: [idemHeader],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['variantId', 'delta'], properties: { variantId: id, delta: { type: 'integer', minimum: -10000, maximum: 10000, not: { const: 0 }, description: 'Units to add (positive) or remove (negative).' }, reason: { type: 'string', enum: ['restocked', 'correction', 'other'], default: 'correction' }, note: { type: 'string', maxLength: 200 } } } } } },
          responses: { ...ok({ type: 'object', properties: { variantId: id, delta: { type: 'integer' }, reason: { type: 'string' }, result: {} } }), ...errors, ...notFound },
        },
      },
      '/customers': { get: { tags: ['Customers'], operationId: 'listCustomers', summary: 'List customers', ...scope('read_customers'), description: 'People who bought from this store, were added to a POS sale, or were added by the seller.', parameters: listParams, responses: { ...ok(page('Customer')), ...errors } } },
      '/customers/{id}': { get: { tags: ['Customers'], operationId: 'getCustomer', summary: 'Get a customer', ...scope('read_customers'), parameters: [idParam('customer')], responses: { ...ok(ref('Customer')), ...errors, ...notFound } } },
    },
    webhooks: Object.fromEntries(WEBHOOK_EVENTS.map((e) => [e, {
      post: {
        summary: `Event ${e}`, operationId: `webhook_${e.replace('.', '_')}`,
        parameters: [
          { name: 'X-Solvexo-Event', in: 'header', schema: { type: 'string', const: e } },
          { name: 'X-Solvexo-Delivery', in: 'header', schema: { type: 'string' }, description: 'Unique per event; ignore one you have already handled.' },
          { name: 'X-Solvexo-Signature', in: 'header', schema: { type: 'string' }, description: '`t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`' },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object', description: WEBHOOK_PAYLOADS[e] } } } },
        responses: { '200': { description: 'Any 2xx answer marks the delivery done.' } },
      },
    }])),
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'sxk_ + 40 hex characters', description: `Scopes: ${API_SCOPES.join(', ')}. A write scope includes the matching read scope.` },
      },
      schemas: {
        Error: { type: 'object', properties: { statusCode: { type: 'integer' }, message: { description: 'What went wrong, in plain words (a string, or a list of strings).' }, error: { type: 'string' } } },
        Store: { type: 'object', properties: { id, name: { type: 'string' }, slug: nullable('string'), currency: { ...nullable('string'), description: 'ISO 4217 code the store prices in.' }, timezone: nullable('string'), domain: { ...nullable('string'), description: 'The verified custom domain, if any.' }, created_at: dt } },
        Address: { type: 'object', properties: { name: nullable('string'), phone: nullable('string'), address1: nullable('string'), address2: nullable('string'), city: nullable('string'), province: nullable('string'), zip: nullable('string'), country: nullable('string') } },
        LineItem: {
          type: 'object', properties: {
            id: { ...id, description: 'Use this id to ship the line.' }, product_id: nullable('string'), variant_id: nullable('string'), name: nullable('string'), sku: nullable('string'),
            type: { type: ['string', 'null'], enum: ['physical', 'digital', null] }, options: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } },
            quantity: { type: 'integer' }, price: money('Unit price.'), total: money('Line total.'), cancelled_at: dt, refunded_amount: money('Refunded on this line.'),
          },
        },
        Shipment: { type: 'object', properties: { id, items: { type: 'array', items: { type: 'object', properties: { line_item_id: id, quantity: { type: 'integer' } } } }, carrier: nullable('string'), tracking_number: nullable('string'), tracking_url: nullable('string'), shipped_at: dt, delivered_at: dt } },
        Order: {
          type: 'object', properties: {
            id, order_number: nullable('string'), created_at: dt, updated_at: dt, currency: { ...nullable('string'), description: 'The currency the buyer paid in; every amount on the order uses it.' },
            status: { type: ['string', 'null'], description: 'This store\'s status for the order.' }, return_status: { type: 'string' },
            paid: { type: 'boolean' }, paid_at: dt, payment_status: nullable('string'), payment_method: nullable('string'),
            fulfillment_method: { type: 'string', enum: ['ship', 'pickup'] }, customer_id: nullable('string'), shipping_address: { oneOf: [ref('Address'), { type: 'null' }] },
            line_items: { type: 'array', items: ref('LineItem') },
            subtotal: money('This store\'s items.'), tax: money('This store\'s tax.'), refunded_total: money('Refunded so far.'),
            shipping: money('Shipping fee. Null on a marketplace order that includes other sellers.'), discount_code: nullable('string'),
            total: money('Amount the buyer paid. Null on a marketplace order that includes other sellers.'),
            shipments: { type: 'array', items: ref('Shipment') }, shipped_at: dt, delivered_at: dt, cancelled_at: dt, cancel_reason: nullable('string'),
          },
        },
        FulfillmentInput: {
          type: 'object', required: ['line_items'], properties: {
            line_items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['id', 'quantity'], properties: { id: { ...id, description: 'A line item id from the order.' }, quantity: { type: 'integer', minimum: 1, maximum: 999 } } } },
            carrier: { type: 'string', maxLength: 80 }, tracking_number: { type: 'string', maxLength: 120 }, tracking_url: { type: 'string', maxLength: 500, format: 'uri' },
            notify_customer: { type: 'boolean', default: true, description: 'Email the buyer that the items shipped.' },
          },
        },
        Inventory: { type: 'object', properties: { tracked: { type: 'boolean', description: 'False when the variant has unlimited stock.' }, on_hand: nullable('integer'), committed: { type: 'integer', description: 'Reserved by open orders.' }, available: { ...nullable('integer'), description: 'What can still be sold; null when not tracked.' }, allow_backorder: { type: 'boolean' } } },
        Variant: {
          type: 'object', properties: {
            id, sku: nullable('string'), barcode: nullable('string'), options: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } },
            price: { type: ['number', 'null'] }, compare_at_price: { type: ['number', 'null'] }, currency: nullable('string'), inventory: ref('Inventory'),
            taxable: { type: 'boolean' }, weight: nullable('string'), images: { type: 'array', items: { type: 'string', format: 'uri' } }, updated_at: dt,
          },
        },
        Product: {
          type: 'object', properties: {
            id, name: { type: 'string' }, slug: nullable('string'), status: { type: 'string', enum: ['active', 'inactive', 'draft', 'scheduled'] }, type: nullable('string'),
            description: { type: 'string', description: 'HTML.' }, short_description: { type: 'string' }, vendor: nullable('string'), tags: { type: 'array', items: { type: 'string' } },
            images: { type: 'array', items: { type: 'string', format: 'uri' } }, category_id: nullable('string'), variants: { type: 'array', items: ref('Variant') }, created_at: dt, updated_at: dt,
          },
        },
        InventoryLevel: { type: 'object', properties: { variant_id: id, product_id: id, sku: nullable('string'), tracked: { type: 'boolean' }, on_hand: nullable('integer'), committed: { type: 'integer' }, available: nullable('integer'), allow_backorder: { type: 'boolean' }, updated_at: dt } },
        Collection: { type: 'object', properties: { id, name: { type: 'string' }, slug: nullable('string'), description: nullable('string'), image: nullable('string'), type: { type: 'string', enum: ['manual', 'automatic'] }, status: nullable('string'), product_ids: { type: ['array', 'null'], items: { type: 'string' }, description: 'Null for automatic (rule-based) collections.' }, created_at: dt, updated_at: dt } },
        Customer: {
          type: 'object', properties: {
            id, name: nullable('string'), email: nullable('string'), phone: nullable('string'), guest: { type: 'boolean', description: 'Checked out without an account.' },
            tags: { type: 'array', items: { type: 'string' } },
            email_marketing: { type: 'boolean', description: 'Agreed to marketing email from this store. Only send marketing to customers where this is true.' },
            sms_marketing: { type: 'boolean' }, whatsapp_marketing: { type: 'boolean' },
            erased: { type: 'boolean', description: 'The customer asked to be forgotten; personal data is not returned.' }, created_at: dt, updated_at: dt,
          },
        },
      },
    },
  };
}

/** What each webhook's JSON body holds (described in words; the docs page shows these). */
export const WEBHOOK_PAYLOADS: Record<string, string> = {
  'order.created': '{ order_id, order_number, status, paid, total, currency }',
  'order.paid': '{ order_id, order_number, status, paid, total, currency }',
  'order.fulfilled': '{ order_id, order_number, status, paid, total, currency }',
  'order.cancelled': '{ order_id, order_number, status, paid, total, currency }',
  'refund.created': '{ order_id, order_number, status, paid, total, currency, refunded_total }',
  'product.updated': '{ product_id, name, slug, status, deleted }',
  'inventory.changed': '{ variant_id, product_id, sku, on_hand, committed, available }',
  'customer.created': '{ customer_id, name, email, phone }',
  'form.submitted': '{ message_id, form_name, name, email, phone, message, fields: [{ label, type, value }], submitted_at }',
};
