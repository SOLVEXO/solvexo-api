'use strict';
const crypto = require('crypto');

/** Where the Solvexo API and website live. Override for staging with SOLVEXO_API_URL / SOLVEXO_WEB_URL in the Zapier app's environment. */
const API = () => (process.env.SOLVEXO_API_URL || 'https://api.solvexo.store').replace(/\/+$/, '');
const WEB = () => (process.env.SOLVEXO_WEB_URL || 'https://www.solvexo.store').replace(/\/+$/, '');
const V1 = () => `${API()}/api/merchant/v1`;

/** Permissions the Zapier app asks a store owner for (must match the app registered in Solvexo). */
const SCOPES = ['read_orders', 'write_orders', 'read_products', 'write_products', 'read_customers', 'read_inventory', 'write_inventory'];

/** A stable key per change, so a retry by Zapier never applies it twice (the API answers a repeat with the first result). */
const idempotencyKey = (...parts) => `zapier:${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;

/** Every request carries the store's token. */
const includeBearer = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.access_token) request.headers.Authorization = `Bearer ${bundle.authData.access_token}`;
  return request;
};

/** Turn API errors into messages a Zap owner can act on. */
const handleErrors = (response, z) => {
  // A call that handles its own errors (e.g. a 404 when unsubscribing a webhook already gone) opts out.
  if (response.request && response.request.skipThrowForStatus) return response;
  if (response.status === 401) throw new z.errors.RefreshAuthError('Solvexo no longer accepts this connection (the app may have been removed from the store). Reconnect your Solvexo account.');
  if (response.status === 429) throw new z.errors.ThrottledError('Solvexo is limiting requests for this store. Zapier will try again shortly.', Number(response.getHeader('retry-after')) || 60);
  if (response.status >= 400) {
    let message = `Solvexo answered ${response.status}`;
    try { const b = JSON.parse(response.content); if (b && b.message) message = Array.isArray(b.message) ? b.message.join('; ') : String(b.message); } catch (e) { /* not JSON */ }
    throw new z.errors.Error(message, response.status === 403 ? 'NoPermission' : 'SolvexoError', response.status);
  }
  return response;
};

module.exports = { API, WEB, V1, SCOPES, idempotencyKey, includeBearer, handleErrors };
