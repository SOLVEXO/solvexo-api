import { normalizeDigital } from './digital-input.util';

const f = (n: string, u: string) => ({ url: 'https://x/' + u, name: n, size: 10 });

describe('normalizeDigital', () => {
  it('keeps indexes stable, archives removed files, appends new', () => {
    const a = normalizeDigital({ files: [f('a.pdf', 'a'), f('b.zip', 'b')], downloadLimit: '3', linkExpiryDays: 7 });
    const b = normalizeDigital({ files: [f('b.zip', 'b'), f('c.mp3', 'c')] }, a);
    expect(b.files.map((x: any) => [x.url.slice(-1), x.archived, x.position])).toEqual([['a', true, 0], ['b', false, 0], ['c', false, 1]]);
    expect(b.downloadLimit).toBe('3');
  });
  it.each([
    [{ files: [f('x.exe', 'x')] }],
    [{ files: [f('a.pdf', 'a')], downloadLimit: '9' }],
    [{ files: [f('a.pdf', 'a')], linkExpiryDays: 0 }],
    [{ files: [] }],
  ])('rejects %j', (bad) => {
    expect(() => normalizeDigital(bad)).toThrow();
  });
});
