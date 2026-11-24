'use strict';
const authentication = require('./authentication');
const { includeBearer, handleErrors } = require('./lib');
const triggers = require('./triggers/hooks');
const { creates } = require('./creates');

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));

/** Solvexo for Zapier. Built on the public Solvexo Admin API (https://www.solvexo.store/developers). */
module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [includeBearer],
  afterResponse: [handleErrors],
  triggers: byKey(triggers),
  creates: byKey(creates),
  searches: {},
};
