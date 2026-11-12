/* eslint-disable prettier/prettier */
/** REGRESSION (gaps close): audit entries of khata / webhooks / API tokens / B2B were dropped because their category was not in the schema enum. */
import * as fs from 'fs';
import * as path from 'path';
import { ACTIVITY_LOG_CATEGORIES } from './schemas/activity-log.schema';

describe('activity log categories', () => {
  it('lists the categories the newer modules write', () => {
    for (const c of ['b2b', 'khata', 'webhooks', 'api_tokens', 'api_token']) expect(ACTIVITY_LOG_CATEGORIES).toContain(c);
  });
  it('every `activity.log({ category: \'x\' ... })` literal in these modules is a known category', () => {
    const root = path.join(__dirname, '..');
    const files = ['khata/khata.service.ts', 'merchant-api/merchant-webhooks.service.ts', 'merchant-api/api-tokens.service.ts', 'merchant-api/api-writes.service.ts', 'b2b/b2b-orders.service.ts', 'b2b/b2b-admin.service.ts', 'auth/member-two-factor.controller.ts'];
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      for (const m of src.matchAll(/category:\s*'([a-z_0-9]+)'/g)) if (!(ACTIVITY_LOG_CATEGORIES as readonly string[]).includes(m[1])) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
