/* eslint-disable prettier/prettier */
import { PermissionOverrides } from './pos-permissions.config';

/**
 * G5.6 — role presets: PROPOSED, pending sign-off by Sir Atiq (see pos/docs/pos-blueprint/ROLE_PRESETS.md). A preset is a complete set of overrides over
 * the documented defaults; applying one REPLACES the store's overrides (so the result is the same whatever was there before). Owner only, preview first,
 * audited with the full before / after diff, guarded by the permissions version. The owner is never removed from anything; pinned actions are untouched.
 */
export interface RolePreset { key: string; label: string; summary: string; overrides: PermissionOverrides }

const R = (...roles: Array<'cashier' | 'manager' | 'owner'>) => ({ roles });

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    key: 'standard',
    label: 'Standard',
    summary: 'The documented defaults: cashiers sell, managers run the shop, the owner controls money settings.',
    overrides: {},
  },
  {
    key: 'small_shop',
    label: 'Small shop',
    summary: 'For a shop where the owner is usually at the till: cashiers may also edit customers, run stock counts and receive goods without a purchase order.',
    overrides: {
      'customers.edit': R('cashier', 'manager', 'owner'),
      'inventory.count.start': R('cashier', 'manager', 'owner'),
      'inventory.count.finish': R('cashier', 'manager', 'owner'),
      'supply.receive.direct': R('cashier', 'manager', 'owner'),
    } as PermissionOverrides,
  },
  {
    key: 'strict',
    label: 'Strict (owner away)',
    summary: 'For a shop run by staff: cashiers cannot adjust stock, record expenses, refund to store credit or clock in for others; managers cannot import the catalog, pay suppliers or adjust store credit.',
    overrides: {
      'inventory.adjust': R('manager', 'owner'),
      'expenses.record': R('manager', 'owner'),
      'storeCredit.refundIssue': R('manager', 'owner'),
      'team.attendance.onBehalf': R('manager', 'owner'),
      'catalog.import': R('owner'),
      'supply.payment': R('owner'),
      'storeCredit.adjust': R('owner'),
    } as PermissionOverrides,
  },
];

export const presetByKey = (k: unknown): RolePreset | undefined => ROLE_PRESETS.find((p) => p.key === k);
