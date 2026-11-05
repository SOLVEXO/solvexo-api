import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readBuildInfo } from './build-info.util';

describe('readBuildInfo', () => {
  it('returns the commit written by the build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-'));
    const f = path.join(dir, 'build-info.json');
    fs.writeFileSync(f, JSON.stringify({ commit: 'abc1234def', shortCommit: 'abc1234', branch: 'staging', dirty: false, builtAt: '2026-11-05T00:00:00.000Z', version: '1.0.0' }));
    expect(readBuildInfo(f)).toMatchObject({ commit: 'abc1234def', shortCommit: 'abc1234', branch: 'staging', version: '1.0.0' });
  });
  it('a missing or corrupt file is "unknown", never an error', () => {
    expect(readBuildInfo('/nonexistent/build-info.json')).toMatchObject({ commit: 'unknown', shortCommit: 'unknown' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-'));
    const f = path.join(dir, 'build-info.json');
    fs.writeFileSync(f, '{not json');
    expect(readBuildInfo(f).commit).toBe('unknown');
  });
});
