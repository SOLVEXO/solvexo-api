/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { POS_ROUTE_TIERS } from './pos-route-tiers';
import { REQUIRE_MANAGER_PIN } from './guards/pos-auth.guard';

/**
 * G4.8 — route tier coverage. Every POS controller route is enumerated from Nest's own metadata. Every non-GET route, and every GET route that returns cost
 * or settings data, must have a declared tier in POS_ROUTE_TIERS; no entry may be stale. The current table is written to pos/docs/pos-blueprint/ROUTE_TIERS.md
 * (when the app repo sits next to this one, as in the dev checkout; set ROUTE_TIERS_OUT to write elsewhere).
 */
const SENSITIVE_GET = /settings|permissions|limits|time-zone|inventory|supply|reports|catalog|products|audit|pulse|dashboard|daybook/;

function routes() {
  const dir = __dirname;
  const out: { key: string; verb: string; path: string; handler: string; guards: string; managerPin: boolean }[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.controller.ts'))) {
    const mod = require(path.join(dir, f));
    for (const C of Object.values(mod) as any[]) {
      if (typeof C !== 'function' || Reflect.getMetadata(PATH_METADATA, C) === undefined) continue;
      const base = Reflect.getMetadata(PATH_METADATA, C);
      for (const k of Object.getOwnPropertyNames(C.prototype)) {
        const h = C.prototype[k];
        if (typeof h !== 'function') continue;
        const m = Reflect.getMetadata(METHOD_METADATA, h);
        if (m === undefined) continue;
        const verb = RequestMethod[m];
        const p = `/${base}/${Reflect.getMetadata(PATH_METADATA, h)}`.replace(/\/+/g, '/').replace(/\/$/, '');
        const guards = [...(Reflect.getMetadata(GUARDS_METADATA, C) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, h) ?? [])].map((g: any) => g.name).join(' + ');
        const managerPin = Reflect.getMetadata(REQUIRE_MANAGER_PIN, h) === true || Reflect.getMetadata(REQUIRE_MANAGER_PIN, C) === true;
        out.push({ key: `${verb} ${p}`, verb, path: p, handler: `${C.name}.${k}`, guards: guards + (managerPin ? ' + manager PIN' : ''), managerPin });
      }
    }
  }
  return out;
}

describe('POS route tiers', () => {
  const all = routes();
  // G4.9: the public receipt links (`/r/...`, no auth by design) are declared too, and must be `public`
  const required = all.filter((r) => r.path.startsWith('/r/') || (r.path.startsWith('/api/pos') && (r.verb !== 'GET' || SENSITIVE_GET.test(r.path))));

  it('enumerates the controllers (sanity)', () => {
    expect(all.length).toBeGreaterThan(150);
    expect(required.length).toBeGreaterThan(100);
  });

  it('every non-GET route, and every GET returning cost or settings data, declares its tier', () => {
    expect(required.filter((r) => !POS_ROUTE_TIERS[r.key]).map((r) => `${r.key}  (${r.handler})`)).toEqual([]);
  });

  it('a route whose guard demands a manager PIN is never declared cashier or public', () => {
    expect(all.filter((r) => r.managerPin && ['cashier', 'public'].includes(POS_ROUTE_TIERS[r.key] ?? '')).map((r) => r.key)).toEqual([]);
  });

  it('G4.9: every public receipt link is declared public, including the offline-buildable /r/s/:store/:key', () => {
    const links = all.filter((r) => r.path.startsWith('/r/'));
    expect(links.map((r) => r.key)).toContain('GET /r/s/:store/:key');
    expect(links.filter((r) => POS_ROUTE_TIERS[r.key] !== 'public').map((r) => r.key)).toEqual([]);
  });

  it('no stale declarations', () => {
    const keys = new Set(all.map((r) => r.key));
    expect(Object.keys(POS_ROUTE_TIERS).filter((k) => !keys.has(k))).toEqual([]);
  });

  afterAll(() => {
    const target = process.env.ROUTE_TIERS_OUT ?? path.resolve(__dirname, '../../../pos/docs/pos-blueprint/ROUTE_TIERS.md');
    if (!fs.existsSync(path.dirname(target))) return;
    const n = (t: string) => required.filter((r) => POS_ROUTE_TIERS[r.key] === t).length;
    const lines = [
      '# POS route tiers (generated)',
      '',
      'Written by `solvexo-api/src/pos/pos-route-tiers.spec.ts` from Nest\'s route metadata and `src/pos/pos-route-tiers.ts`. Do not edit by hand — change the registry and run the spec.',
      '',
      '**Tiers:** `owner` = the owner\'s own session only · `manager-with-limit` = a manager or the owner (some actions have per-store approval limits) · `cashier` = any PIN-signed employee (approval limits may ask for a manager) · `public` = no PIN session (device, PIN login, public receipt).',
      '',
      `**Declared:** ${required.length} routes — owner ${n('owner')}, manager-with-limit ${n('manager-with-limit')}, cashier ${n('cashier')}, public ${n('public')}. Other GET routes (no cost / settings data): ${all.filter((r) => r.path.startsWith('/api/pos') && !required.includes(r)).length}.`,
      '',
      '| Method | Route | Tier | Handler | Guards |',
      '|---|---|---|---|---|',
      ...[...required].sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb)).map((r) => `| ${r.verb} | \`${r.path}\` | ${POS_ROUTE_TIERS[r.key] ?? '**UNDECLARED**'} | ${r.handler} | ${r.guards || '—'} |`),
      '',
    ];
    fs.writeFileSync(target, lines.join('\n'));
  });
});
