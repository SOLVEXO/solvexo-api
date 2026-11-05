import * as fs from 'fs';
import * as path from 'path';

export interface BuildInfo { commit: string; shortCommit: string; branch: string; dirty: boolean; builtAt: string | null; version: string | null }

const UNKNOWN: BuildInfo = { commit: 'unknown', shortCommit: 'unknown', branch: 'unknown', dirty: false, builtAt: null, version: null };

/** dist/build-info.json sits next to dist/main.js (this file is dist/health/build-info.util.js). Never throws: a missing file means "unknown". */
export function readBuildInfo(file = path.join(__dirname, '..', 'build-info.json')): BuildInfo {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...UNKNOWN, ...j };
  } catch {
    return { ...UNKNOWN };
  }
}
