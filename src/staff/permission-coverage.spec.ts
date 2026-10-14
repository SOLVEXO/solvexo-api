/**
 * Static guard-rail for the staff permission system. It reads every controller with the TypeScript compiler (no
 * server, no database) and fails when:
 *  - a route open to staff has no @RequirePermission (a staff member would pass it with ANY role);
 *  - a staff-enabled route is missing PermissionsGuard (the permission would never be checked, and the staff
 *    member would not be pinned to their own store);
 *  - a @RequirePermission key is not in STAFF_PERMISSIONS (a typo makes the route unreachable for every staff role);
 *  - a permission in STAFF_PERMISSIONS is used by no route (a dead toggle in the role editor).
 */
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { STAFF_PERMISSIONS } from './schemas/staff-member.schema';

const SRC = path.join(__dirname, '..');

/** Staff-callable routes that are intentionally not permission-gated (own-account / device login). */
const NO_PERMISSION_BY_DESIGN = new Set([
  'api/staff/me', // a staff member editing their own profile
  'api/staff/me/password',
  'api/pos/pin-login', // PIN login for the POS app
]);
/** Permissions that gate UI only (no dedicated backend route). */
const UI_ONLY_PERMISSIONS = new Set(['home.view']);

interface Route { file: string; method: string; route: string; fn: string; roles: string[] | null; perms: string[] | null; guards: string[]; jwt: boolean }

const decorators = (n: ts.Node) => (ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []);
/** String constants / string-array constants declared in the same file (e.g. `const STAFF_VIEW = ['a.view', 'a.manage']`). */
function fileConstants(sf: ts.SourceFile): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const literal = (e: ts.Expression): string[] | null => {
    if (ts.isStringLiteralLike(e)) return [e.text];
    if (ts.isArrayLiteralExpression(e)) {
      const out: string[] = [];
      for (const el of e.elements) {
        if (ts.isStringLiteralLike(el)) out.push(el.text);
        else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression) && map.has(el.expression.text)) out.push(...map.get(el.expression.text)!);
        else return null;
      }
      return out;
    }
    if (ts.isAsExpression(e)) return literal(e.expression);
    return null;
  };
  sf.forEachChild((n) => {
    if (!ts.isVariableStatement(n)) return;
    for (const d of n.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) {
        const v = literal(d.initializer);
        if (v) map.set(d.name.text, v);
      }
    }
  });
  return map;
}

function describeDecorator(d: ts.Decorator, consts: Map<string, string[]>) {
  const e = d.expression;
  if (!ts.isCallExpression(e)) return { name: e.getText(), args: [] as string[] };
  const args: string[] = [];
  for (const a of e.arguments) {
    if (ts.isStringLiteralLike(a)) args.push(a.text);
    else if (ts.isSpreadElement(a) && ts.isIdentifier(a.expression) && consts.has(a.expression.text)) args.push(...consts.get(a.expression.text)!);
    else if (ts.isIdentifier(a) && consts.has(a.text)) args.push(...consts.get(a.text)!);
    else args.push(a.getText().replace(/['"`]/g, ''));
  }
  return { name: e.expression.getText(), args };
}

function collectRoutes(): Route[] {
  const routes: Route[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.controller.ts')) parse(full);
    }
  };
  const parse = (file: string) => {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const consts = fileConstants(sf);
    sf.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const cls = decorators(node).map((d) => describeDecorator(d, consts));
      const ctrl = cls.find((d) => d.name === 'Controller');
      if (!ctrl) return;
      const classRoles = cls.find((d) => d.name === 'Roles')?.args ?? null;
      const classPerms = cls.find((d) => d.name === 'RequirePermission')?.args ?? null;
      const classGuards = cls.filter((d) => d.name === 'UseGuards').flatMap((d) => d.args);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const md = decorators(member).map((d) => describeDecorator(d, consts));
        const verb = md.find((d) => ['Get', 'Post', 'Put', 'Patch', 'Delete'].includes(d.name));
        if (!verb) continue;
        routes.push({
          file: path.relative(SRC, file).split(path.sep).join('/'),
          method: verb.name.toUpperCase(),
          route: `${ctrl.args[0] ?? ''}/${verb.args[0] ?? ''}`.replace(/\/$/, ''),
          fn: member.name.getText(),
          roles: md.find((d) => d.name === 'Roles')?.args ?? classRoles,
          perms: md.find((d) => d.name === 'RequirePermission')?.args ?? classPerms,
          guards: [...classGuards, ...md.filter((d) => d.name === 'UseGuards').flatMap((d) => d.args)],
          jwt: [...classGuards, ...md.filter((d) => d.name === 'UseGuards').flatMap((d) => d.args)].some((g) => /JwtAuthGuard/.test(g) && !/Optional/.test(g)),
        });
      }
    });
  };
  walk(SRC);
  return routes;
}

describe('staff permission coverage (static)', () => {
  const routes = collectRoutes();
  const staffRoutes = routes.filter((r) => r.roles?.includes('staff'));

  it('finds a realistic number of controllers/routes (the scan itself works)', () => {
    expect(routes.length).toBeGreaterThan(900);
    expect(staffRoutes.length).toBeGreaterThan(400);
  });

  it('every staff-enabled route declares @RequirePermission', () => {
    const missing = staffRoutes
      .filter((r) => !r.perms && !NO_PERMISSION_BY_DESIGN.has(r.route))
      .map((r) => `${r.method} ${r.route} (${r.file} :: ${r.fn})`);
    expect(missing).toEqual([]);
  });

  it('every staff-enabled route with a permission also runs PermissionsGuard (store pinning + the check itself)', () => {
    const unguarded = staffRoutes
      .filter((r) => r.perms && !r.guards.some((g) => /PermissionsGuard/.test(g)))
      .map((r) => `${r.method} ${r.route} (${r.file} :: ${r.fn})`);
    expect(unguarded).toEqual([]);
  });

  it('every @RequirePermission key exists in STAFF_PERMISSIONS (no typos)', () => {
    const known = new Set<string>(STAFF_PERMISSIONS);
    const unknown = routes.flatMap((r) => (r.perms ?? []).filter((p) => !known.has(p)).map((p) => `${p} on ${r.method} ${r.route}`));
    expect(unknown).toEqual([]);
  });

  it('every permission is enforced somewhere (route decorator or an in-code check) - no dead toggles in the role editor', () => {
    const used = new Set(routes.flatMap((r) => r.perms ?? []));
    // Permissions checked imperatively (e.g. hiding cost prices, price edits) show up as string literals outside the registry/presets.
    const IGNORE = ['staff-member.schema.ts', 'role.service.ts'];
    const walkTs = (dir: string, out: string[] = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkTs(full, out);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !IGNORE.includes(e.name)) out.push(full);
      }
      return out;
    };
    const sources = walkTs(SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const dead = STAFF_PERMISSIONS.filter((perm) => !used.has(perm) && !UI_ONLY_PERMISSIONS.has(perm) && !sources.includes(`'${perm}'`));
    expect(dead).toEqual([]);
  });

  it('the permissions added for catalog / draft orders / reviews / activity log are enforced where staff work', () => {
    const has = (perm: string, route: RegExp) => routes.some((r) => (r.perms ?? []).includes(perm) && route.test(r.route));
    expect(has('products.create', /add-physical-product/)).toBe(true);
    expect(has('products.create', /duplicate-product/)).toBe(true);
    expect(has('collections.manage', /api\/collections/)).toBe(true);
    expect(has('categories.manage', /api\/categories/)).toBe(true);
    expect(has('draft_orders.manage', /api\/draft-orders/)).toBe(true);
    expect(has('reviews.manage', /api\/rating\/reply/)).toBe(true);
    expect(has('activity_log.view', /api\/activity-log/)).toBe(true);
    expect(has('marketing.manage', /api\/email-campaigns/)).toBe(true);
  });
});
