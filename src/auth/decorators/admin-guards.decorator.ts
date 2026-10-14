import { SetMetadata } from '@nestjs/common';

/** Admin routes any signed-in admin may call about THEIR OWN account (sessions, profile) — no team permission needed. */
export const ADMIN_SELF_KEY = 'adminSelf';
export const AdminSelf = () => SetMetadata(ADMIN_SELF_KEY, true);

/** Sensitive admin action: a TEAM admin needs a Super Admin's one-time approval first (the Super Admin / owner never does).
 *  The key names the action in the approvals queue, e.g. 'payout.manual'. */
export const ADMIN_APPROVAL_KEY = 'adminApproval';
export const RequireApproval = (action: string) => SetMetadata(ADMIN_APPROVAL_KEY, action);
