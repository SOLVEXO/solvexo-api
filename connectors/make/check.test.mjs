// Keeps the Make app in step with the API: run with `node --test connectors/make` (no Make account needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(here, f), 'utf8'));
const util = readFileSync(join(here, '../../src/merchant-api/merchant-api.util.ts'), 'utf8');
const listOf = (name) => JSON.parse(util.match(new RegExp(`export const ${name} = (\\[[^\\]]+\\])`))[1].replace(/'/g, '"'));
const EVENTS = listOf('WEBHOOK_EVENTS');
const SCOPES = listOf('API_SCOPES');
const modules = readdirSync(join(here, 'modules')).map((f) => ({ file: f, ...read(`modules/${f}`) }));

test('every file is valid JSON with the parts Make needs', () => {
  for (const f of ['base.json', 'connection.communication.json', 'connection.common.json', 'webhook.communication.json', 'webhook.parameters.json']) read(f);
  for (const m of modules) {
    assert.ok(m.name && m.label && m.description, `${m.file}: name, label, description`);
    assert.ok(['action', 'search', 'instant_trigger'].includes(m.type), `${m.file}: type`);
    assert.ok(m.communication, `${m.file}: communication`);
    assert.ok(Array.isArray(m.interface), `${m.file}: interface`);
  }
  assert.equal(new Set(modules.map((m) => m.name)).size, modules.length, 'module names are unique');
});

test('the event list is exactly the API\'s webhook events', () => {
  const opts = read('webhook.parameters.json')[0].options.map((o) => o.value);
  assert.deepEqual([...opts].sort(), [...EVENTS].sort());
});

test('the connection asks only for scopes the API knows, signs in at the fixed address, and swaps the code form-encoded', () => {
  const c = read('connection.communication.json');
  assert.equal(c.authorize.url, 'https://www.solvexo.store/oauth/authorize');
  for (const s of c.authorize.qs.scope.split(' ')) assert.ok(SCOPES.includes(s), s);
  assert.equal(c.token.type, 'urlencoded');
  assert.equal(c.token.body.grant_type, 'authorization_code');
  assert.ok(c.token.log.sanitize.includes('request.body.client_secret'));
});

test('every write sends an Idempotency-Key the API accepts; subscribe/unsubscribe use the token\'s own webhooks', () => {
  for (const m of modules) {
    const method = m.communication.method;
    if (['POST', 'PATCH'].includes(method)) assert.match(m.communication.headers['Idempotency-Key'], /^make:\{\{.+\}\}$/, m.file);
  }
  const w = read('webhook.communication.json');
  assert.equal(w.attach.url, '/webhooks');
  assert.equal(w.detach.method, 'DELETE');
  assert.equal(modules.find((m) => m.type === 'instant_trigger').webhook, 'solvexoEvent');
});

test('the base never logs the token', () => {
  assert.deepEqual(read('base.json').log.sanitize, ['request.headers.authorization']);
});
