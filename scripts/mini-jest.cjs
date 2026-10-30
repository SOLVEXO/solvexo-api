// Fallback when jest/ts-jest cannot load (see CLAUDE.md section 19): runs plain describe/it specs.
// Usage: NODE_OPTIONS=--max-old-space-size=6144 node scripts/mini-jest.cjs src/x/y.spec.ts [more specs]
// Tiny jest-compatible runner (describe/it/beforeEach/expect subset) so the REAL spec files run here without ts-jest.
const path = require('path');
const assert = require('assert');
process.env.NODE_PATH = require('path').join(__dirname, '..', 'node_modules');
require('module').Module._initPaths();
require('ts-node').register({ project: require('path').join(__dirname, '..', 'tsconfig.json'), transpileOnly: false });
require('tsconfig-paths').register({ baseUrl: require('path').join(__dirname, '..', 'src'), paths: { '@/*': ['*'] } });

const stack = [{ name: '', before: [], tests: [] }];
const top = () => stack[stack.length - 1];
global.describe = (name, fn) => { const s = { name, before: [], tests: [], parent: top() }; top().tests.push(s); stack.push(s); fn(); stack.pop(); };
global.beforeEach = (fn) => top().before.push(fn);
global.it = global.test = (name, fn) => top().tests.push({ name, fn, parent: top() });
global.jest = { fn: (impl) => { const f = (...a) => { f.calls.push(a); return impl ? impl(...a) : undefined; }; f.calls = []; f.mock = { calls: f.calls }; f.mockResolvedValue = (v) => { impl = async () => v; return f; }; return f; } };

const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
function expect(actual) {
  const mk = (neg) => {
    const chk = (ok, msg) => { if (neg ? ok : !ok) throw new assert.AssertionError({ message: (neg ? 'NOT ' : '') + msg }); };
    return {
      toBe: (e) => chk(Object.is(actual, e), `expected ${fmt(actual)} to be ${fmt(e)}`),
      toEqual: (e) => { let ok = true; try { assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(e))); } catch { ok = false; } chk(ok, `expected ${fmt(actual)} to equal ${fmt(e)}`); },
      toBeTruthy: () => chk(!!actual, `expected ${fmt(actual)} truthy`),
      toBeFalsy: () => chk(!actual, `expected ${fmt(actual)} falsy`),
      toBeNull: () => chk(actual === null, `expected ${fmt(actual)} null`),
      toBeDefined: () => chk(actual !== undefined, 'expected defined'),
      toBeGreaterThan: (n) => chk(actual > n, `expected ${actual} > ${n}`),
      toBeLessThan: (n) => chk(actual < n, `expected ${actual} < ${n}`),
      toHaveLength: (n) => chk(actual.length === n, `expected length ${actual && actual.length} to be ${n}`),
      toContain: (x) => chk(actual.includes(x), `expected ${fmt(actual)} to contain ${fmt(x)}`),
      toMatch: (re) => chk(re.test(actual), `expected ${fmt(actual)} to match ${re}`),
      toThrow: (m) => { let threw = false, err; try { actual(); } catch (e) { threw = true; err = e; } chk(threw && (!m || String(err.message).includes(m)), 'expected function to throw' + (m ? ' ' + m : '')); },
      get rejects() {
        return { toThrow: async (m) => { let threw = false, err; try { await actual; } catch (e) { threw = true; err = e; } chk(threw && (!m || String(err.message).includes(m)), `expected promise to reject${m ? ' with ' + m : ''}${threw ? ' (got: ' + err.message + ')' : ' (resolved)'}`); },
          toMatchObject: async (o) => { let err; try { await actual; } catch (e) { err = e; } chk(err && Object.entries(o).every(([k, v]) => (err[k] ?? (err.getStatus && k === 'status' ? err.getStatus() : undefined)) === v), 'rejection did not match ' + fmt(o)); } };
      },
    };
  };
  const base = mk(false);
  base.not = mk(true);
  return base;
}
global.expect = expect;

async function runSuite(s, befores, prefix, res) {
  const bs = [...befores, ...s.before];
  for (const t of s.tests) {
    const label = prefix + (t.name ? t.name : '');
    if (t.tests) { await runSuite(t, bs, label + ' > ', res); continue; }
    try { for (const b of bs) await b(); await t.fn(); res.pass++; console.log('  ok   ' + label); }
    catch (e) { res.fail++; console.log('  FAIL ' + label + '\n         ' + String(e && e.message).split('\n')[0]); }
  }
}
(async () => {
  const files = process.argv.slice(2);
  const res = { pass: 0, fail: 0 };
  for (const f of files) {
    stack.length = 1; stack[0].tests = []; stack[0].before = [];
    console.log(path.basename(f));
    require(path.resolve(f));
    await runSuite(stack[0], [], '', res);
  }
  console.log(`\n${res.pass} passed, ${res.fail} failed`);
  process.exit(res.fail ? 1 : 0);
})();
