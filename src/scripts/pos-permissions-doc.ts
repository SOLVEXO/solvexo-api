/* eslint-disable no-console */
// Prints the permission matrix + approval limits as the markdown tables of docs/pos-blueprint/G3_PERMISSIONS_AND_LIMITS.md:
//   npx ts-node -r tsconfig-paths/register src/scripts/pos-permissions-doc.ts
import { APPROVAL_LIMITS, POS_PERMISSIONS } from '../pos/pos-permissions.config';
const rows = Object.entries(POS_PERMISSIONS).map(([a, r]: [string, any]) => {
  const has = (x: string) => (r.roles.includes(x) ? '✔' : '—');
  const appr = (r.approval ?? []).map((p: any) => p.always ? `always → ${p.approver}` : `${p.limit} > limit → ${p.approver}`).join('; ') || '';
  return `| \`${a}\` | ${r.label} | ${has('cashier')} | ${has('manager')} | ${has('owner')} | ${appr} |`;
});
const lim = Object.entries(APPROVAL_LIMITS).map(([k, d]: [string, any]) => `| \`${k}\` | ${d.label} | ${d.kind === 'minor' ? d.default.toFixed(2) + ' (major units of the store currency)' : d.default + (k.includes('Points') ? ' points' : ' units')} |`);
console.log(`| Action | What | Cashier | Manager | Owner | Needs approval |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n| Limit | What it limits | Default |\n|---|---|---|\n${lim.join('\n')}`);
