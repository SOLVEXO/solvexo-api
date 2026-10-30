/* eslint-disable prettier/prettier */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * JwtAuthGuard injects RedisService. When a module's controller uses the guard but the module doesn't import
 * RedisModule, the app still boots but every request to that controller fails with a 500
 * ("Cannot read properties of undefined (reading 'isConnected')"). This has shipped several times (gift cards,
 * metafields, menus, POS plans, platform tax, theme catalog), so check every module statically.
 */
// POS plans is fixed on feature/jamibranch (64889f0); remove it from here once that branch is merged.
const PENDING_ELSEWHERE = new Set(['pos-plans/pos-plans.module.ts']);

const SRC = join(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

describe('modules whose controllers use JwtAuthGuard import RedisModule', () => {
  it('every one does', () => {
    const files = walk(SRC);
    const missing: string[] = [];
    for (const mod of files.filter((f) => f.endsWith('.module.ts'))) {
      const src = readFileSync(mod, 'utf8');
      if (!/controllers:\s*\[/.test(src)) continue;
      const dir = mod.slice(0, mod.lastIndexOf('/'));
      const usesGuard = files.some((f) => f.startsWith(dir + '/') && f.endsWith('.controller.ts') && /JwtAuthGuard/.test(readFileSync(f, 'utf8')));
      const rel = relative(SRC, mod);
      if (usesGuard && !/RedisModule/.test(src) && !PENDING_ELSEWHERE.has(rel)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});
