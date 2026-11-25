'use strict';
const { API, WEB, V1, SCOPES } = require('./lib');

/**
 * OAuth 2.0 (authorization code), the same install flow every Solvexo app uses: the store owner signs in at
 * solvexo.store, picks a store and allows the permissions. The token doesn't expire; it stops when they remove the app.
 * CLIENT_ID / CLIENT_SECRET come from the app registered in Solvexo (Build apps); set them with `zapier env:set`.
 */
module.exports = {
  type: 'oauth2',
  oauth2Config: {
    authorizeUrl: {
      url: `${WEB()}/oauth/authorize`,
      params: {
        client_id: '{{process.env.CLIENT_ID}}',
        state: '{{bundle.inputData.state}}',
        redirect_uri: '{{bundle.inputData.redirect_uri}}',
        scope: SCOPES.join(' '),
      },
    },
    getAccessToken: {
      url: `${API()}/api/app-platform/oauth/token`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: {
        grant_type: 'authorization_code',
        code: '{{bundle.inputData.code}}',
        client_id: '{{process.env.CLIENT_ID}}',
        client_secret: '{{process.env.CLIENT_SECRET}}',
        redirect_uri: '{{bundle.inputData.redirect_uri}}',
      },
    },
    scope: SCOPES.join(' '),
    autoRefresh: false,
  },
  fields: [],
  // Checks the connection works and names it after the store.
  test: { url: `${V1()}/store` },
  connectionLabel: '{{name}}',
};
