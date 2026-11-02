/* eslint-disable prettier/prettier */
import type { LeadStage } from './sales-ops.constants';

/** Who is asking: the owner / a Super Admin / a team admin with `sales.manage` see every lead; a rep sees their own. */
export interface SalesActor {
  adminId: string;
  canSeeAll: boolean;
}

export function salesActor(user: {
  userId?: string;
  teamAdmin?: boolean;
  permissions?: string[];
}): SalesActor {
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return {
    adminId: String(user.userId ?? ''),
    canSeeAll: !user.teamAdmin || perms.includes('sales.manage'),
  };
}

/** Mongo filter limiting leads to what the actor may see. */
export const leadScope = (a: SalesActor) =>
  a.canSeeAll ? {} : { ownerAdminId: a.adminId };

export const normalizeEmail = (e?: string | null) =>
  e && e.trim() ? e.trim().toLowerCase() : null;

/** Last 10 digits, so "+92 300 0000000", "0300-0000000" and "3000000000" all match. Null under 7 digits. */
export function phoneKey(p?: string | null): string | null {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
}

const RANK: Record<string, number> = {
  new: 0,
  contacted: 1,
  demo: 2,
  trial: 3,
  won: 4,
};

/** Where a merchant account stands, as far as sales is concerned. */
export type MerchantState = 'signed_up' | 'trial' | 'paying' | 'not_paying';

/**
 * The stage a linked lead should move to on its own, or null to leave it. Only ever forward: a trial puts an earlier
 * lead (or a lost one that came back) into Trial; paying wins it. Signing up alone doesn't move it: a person decides.
 */
export function autoStage(
  current: string,
  state: MerchantState,
): LeadStage | null {
  if (state === 'paying') return current === 'won' ? null : 'won';
  if (state === 'trial')
    return current === 'lost' || (RANK[current] ?? 0) < RANK.trial
      ? 'trial'
      : null;
  return null;
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Fills `{{name}}`-style fields. Unknown fields are left as they are so a typo shows up in the preview. */
export function fillTemplate(
  text: string,
  vars: Record<string, string | null | undefined>,
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m,
  );
}

/** Plain-text email body → safe HTML paragraphs (blank line = new paragraph, single line break kept). */
export function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map(
      (p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

export interface StageCount {
  stage: string;
  count: number;
  valuePKR: number;
}

/** Count and total deal value per stage, in pipeline order. */
export function stageTotals(
  rows: { stage: string; dealValuePKR?: number | null }[],
  stages: readonly string[],
): StageCount[] {
  return stages.map((stage) => {
    const r = rows.filter((x) => x.stage === stage);
    return {
      stage,
      count: r.length,
      valuePKR: r.reduce((s, x) => s + (x.dealValuePKR ?? 0), 0),
    };
  });
}
