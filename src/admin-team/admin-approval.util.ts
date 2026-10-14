import { ForbiddenException } from '@nestjs/common';

export const APPROVAL_REQUEST_TTL_MIN = 60 * 24; // a pending request goes stale after a day
export const APPROVAL_GRANT_TTL_MIN = 30; // an approval can be used for 30 minutes, once

/** Human names of the actions that need a Super Admin's approval when a TEAM admin does them. */
export const ADMIN_APPROVAL_ACTIONS: Record<string, string> = {
  'payout.manual': 'Create a manual payout',
  'payout.approve': 'Approve a payout',
  'payout.reverse': 'Reverse a payout',
  'commission.change': 'Change commission rules',
  'plans.change': 'Change platform plans',
  'admin.delete': 'Delete an admin account',
};

/** Called by PermissionsGuard for a team admin on a route marked @RequireApproval(key).
 *  - an approved, unexpired grant for this admin + action is consumed (one use) and the request goes through;
 *  - otherwise a pending request is opened (once) and the call is refused with a clear "ask the Super Admin" message. */
export async function consumeOrRequestApproval(db: any, user: any, action: string, summary: string): Promise<void> {
  const model = db.repositories.adminApprovalModel;
  const adminId = String(user.userId);
  const now = new Date();

  const grant = await model.findOneAndUpdate(
    { requestedBy: adminId, action, status: 'approved', expiresAt: { $gt: now } },
    { $set: { status: 'used' } },
    { sort: { createdAt: 1 } },
  );
  if (grant) return;

  const open = await model.findOne({ requestedBy: adminId, action, status: 'pending', expiresAt: { $gt: now } }).lean();
  if (!open) {
    const admin = await db.repositories.adminModel.findById(adminId).select('name email').lean();
    await model.create({
      action, summary: summary.slice(0, 300), requestedBy: adminId, requestedByName: (admin as any)?.name ?? (admin as any)?.email ?? null,
      expiresAt: new Date(now.getTime() + APPROVAL_REQUEST_TTL_MIN * 60000),
    });
  }
  throw new ForbiddenException(`"${ADMIN_APPROVAL_ACTIONS[action] ?? action}" needs the Super Admin's approval. A request has been sent: once it is approved, repeat this action within ${APPROVAL_GRANT_TTL_MIN} minutes.`);
}
