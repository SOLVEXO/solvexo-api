/**
 * Static guard-rail for the cron jobs (no server, no Redis, no database). Every @Cron job runs on every API copy, so each one
 * must (1) be wrapped in runLocked (one copy per tick), (2) use a lock name no other job uses, (3) use a sane lock TTL, and
 * (4) have a valid cron expression. runLocked itself is exercised with a fake Redis: a held lock skips the job, a free lock runs it.
 */
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { SchedulerService } from './scheduler.service';

const FILE = path.join(__dirname, 'scheduler.service.ts');
const sf = ts.createSourceFile(FILE, fs.readFileSync(FILE, 'utf8'), ts.ScriptTarget.ES2020, true);

interface Job { method: string; cron: string; locks: { name: string; ttl: number | null }[] }
const jobs: Job[] = [];

const decoratorsOf = (n: ts.Node) => (ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []);
const str = (e: ts.Expression | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null);

function ttlOf(e: ts.Expression | undefined): number | null {
  if (!e) return null;
  if (ts.isNumericLiteral(e)) return Number(e.text.replace(/_/g, ''));
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const a = ttlOf(e.left), b = ttlOf(e.right);
    return a !== null && b !== null ? a * b : null;
  }
  if (ts.isParenthesizedExpression(e)) return ttlOf(e.expression);
  return null;
}

function visit(n: ts.Node) {
  if (ts.isMethodDeclaration(n) && n.body) {
    const cron = decoratorsOf(n).find((d) => ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === 'Cron');
    if (cron) {
      const call = cron.expression as ts.CallExpression;
      const locks: Job['locks'] = [];
      const walk = (x: ts.Node) => {
        if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'runLocked' && x.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          locks.push({ name: str(x.arguments[0]) ?? '<dynamic>', ttl: ttlOf(x.arguments[1]) });
        }
        ts.forEachChild(x, walk);
      };
      walk(n.body);
      jobs.push({ method: n.name.getText(sf), cron: str(call.arguments[0]) ?? '<non-literal>', locks });
    }
  }
  ts.forEachChild(n, visit);
}
visit(sf);

describe('scheduler cron jobs', () => {
  it('finds the jobs', () => {
    expect(jobs.length).toBeGreaterThan(40);
  });

  it('every job is wrapped in runLocked', () => {
    const bad = jobs.filter((j) => j.locks.length === 0).map((j) => j.method);
    expect(bad).toEqual([]);
  });

  it('lock names are literal and unique (two jobs sharing a lock would starve each other)', () => {
    const names = jobs.flatMap((j) => j.locks.map((l) => l.name));
    expect(names.filter((n) => n === '<dynamic>')).toEqual([]);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dup).toEqual([]);
  });

  it('lock TTLs are between 30 s and 6 h', () => {
    const bad = jobs.flatMap((j) => j.locks.filter((l) => l.ttl === null || l.ttl < 30_000 || l.ttl > 6 * 3_600_000).map((l) => `${j.method}:${l.name}:${l.ttl}`));
    expect(bad).toEqual([]);
  });

  it('cron expressions have 5 or 6 fields and use only allowed characters', () => {
    const bad = jobs.filter((j) => !/^[\d*/,\-\s]+$/.test(j.cron) || ![5, 6].includes(j.cron.trim().split(/\s+/).length)).map((j) => `${j.method}: ${j.cron}`);
    expect(bad).toEqual([]);
  });

  it('method names are unique', () => {
    const names = jobs.map((j) => j.method);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});

describe('runLocked behaviour (fake Redis)', () => {
  const make = (held: boolean) => {
    const calls: string[] = [];
    const redis = {
      withLock: async (key: string, _ttl: number, fn: () => Promise<void>) => {
        calls.push(key);
        if (held) return 'lock_not_acquired';
        await fn();
        return 'ok';
      },
    };
    const svc: any = Object.create(SchedulerService.prototype);
    svc.redis = redis;
    svc.logger = { debug: () => undefined, log: () => undefined, error: () => undefined };
    return { svc, calls };
  };

  it('runs the job when the lock is free and prefixes the key', async () => {
    const { svc, calls } = make(false);
    let ran = 0;
    await svc.runLocked('x-job', 1000, async () => { ran++; });
    expect(ran).toBe(1);
    expect(calls).toEqual(['cron-lock:x-job']);
  });

  it('skips the job when another copy holds the lock', async () => {
    const { svc } = make(true);
    let ran = 0;
    await svc.runLocked('x-job', 1000, async () => { ran++; });
    expect(ran).toBe(0);
  });
});
