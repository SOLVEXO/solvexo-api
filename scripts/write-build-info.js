#!/usr/bin/env node
/**
 * Runs at the end of `npm run build` and writes dist/build-info.json, which GET /health/version serves, so "which commit is the
 * server actually running?" has a definite answer. The commit comes from CI (GITHUB_SHA) or from git on the machine that builds.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const commit = process.env.GITHUB_SHA || run('git rev-parse HEAD') || 'unknown';
const info = {
  commit,
  shortCommit: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
  branch: process.env.GITHUB_REF_NAME || run('git rev-parse --abbrev-ref HEAD') || 'unknown',
  dirty: run('git status --porcelain') ? true : false,
  builtAt: new Date().toISOString(),
  version: require('../package.json').version,
};
const out = path.join(__dirname, '..', 'dist', 'build-info.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(info, null, 2));
console.log(`build-info: ${info.shortCommit} (${info.branch})${info.dirty ? ' + uncommitted changes' : ''} → ${path.relative(process.cwd(), out)}`);
