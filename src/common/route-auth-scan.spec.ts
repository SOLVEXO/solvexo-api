import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Q9: every HTTP route must sit behind a guard (class or method level) or be on the justified public allow-list.
 * Guards that count: JwtAuthGuard, OptionalJwtAuthGuard (identity optional, the service must scope), ApiTokenGuard,
 * AdminGuard-style names ending in "Guard". Any @UseGuards counts; an empty or missing one does not.
 */
const HTTP = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All']);

/** file (relative to src) -> why its routes are public. A new public controller must be added here with a reason. */
const PUBLIC_FILES: Record<string, string> = {
  'health/health.controller.ts': 'liveness/readiness probes',
  'app-platform/app-platform.controller.ts': 'OAuth token exchange authenticates with the client secret + single-use code',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

function decoratorsOf(n: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(n) ? [...(ts.getDecorators(n) ?? [])] : [];
}
function decoName(d: ts.Decorator): string {
  const e = d.expression;
  return ts.isCallExpression(e) ? e.expression.getText() : e.getText();
}
function hasGuard(ds: ts.Decorator[]): boolean {
  return ds.some((d) => decoName(d) === 'UseGuards' && ts.isCallExpression(d.expression) && d.expression.arguments.length > 0);
}

describe('route auth scan', () => {
  const root = path.join(__dirname, '..');
  const unguarded: string[] = [];
  let routes = 0;
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (PUBLIC_FILES[rel]) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    sf.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const classDs = decoratorsOf(node);
      if (!classDs.some((d) => decoName(d) === 'Controller')) return;
      const classGuard = hasGuard(classDs);
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m)) continue;
        const ds = decoratorsOf(m);
        if (!ds.some((d) => HTTP.has(decoName(d)))) continue;
        routes++;
        if (!classGuard && !hasGuard(ds)) { unguarded.push(`${rel}#${node.name?.text}.${m.name.getText()}`); if (process.env.ROUTE_SCAN_DUMP) fs.appendFileSync(process.env.ROUTE_SCAN_DUMP, `${ds.map(decoName).filter((n) => HTTP.has(n)).join("")} ${rel}#${node.name?.text}.${m.name.getText()}
`); }
      }
    });
  }

  it('scans a realistic number of routes', () => { expect(routes).toBeGreaterThan(500); });

  it('every unguarded route is in the justified allow-list', () => {
    // Routes that are public on purpose (checked one by one in docs/parity/LAUNCH-NOTES.md). Keep this list small.
    const allow = new Set<string>(JSON.parse(fs.readFileSync(path.join(__dirname, 'route-auth-allowlist.json'), 'utf8')).routes);
    const bad = unguarded.filter((r) => !allow.has(r));
    expect(bad).toEqual([]);
  });
});
