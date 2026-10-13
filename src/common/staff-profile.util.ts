import { UnauthorizedException } from '@nestjs/common';
import { STAFF_PERMISSIONS } from '../staff/schemas/staff-member.schema';

/** Profile shape the web app's `useGetProfile` expects, built for a STAFF
 *  session (staff live in their own collection, so `AuthService.getProfile`'s
 *  user/seller/admin lookup can't serve them). Permissions are resolved from
 *  the staff member's CURRENT role. */
export async function buildStaffProfile(repos: any, staffId: string) {
  const staff: any = await repos.staffMemberModel.findById(staffId).lean();
  if (!staff || staff.isDelete) throw new UnauthorizedException('User not found');
  const [role, store]: any[] = await Promise.all([
    staff.roleId ? repos.roleModel.findOne({ _id: staff.roleId, storeId: staff.storeId, isDelete: false }).select('name permissions').lean() : null,
    repos.storeModel.findById(staff.storeId).select('name').lean(),
  ]);
  return {
    _id: staff._id, name: staff.name, email: staff.email, phone: '', address: '',
    isVerified: !!staff.inviteAcceptedAt, profileImage: null, status: staff.status, role: 'staff', currencyPreference: null,
    createdAt: staff.createdAt, updatedAt: staff.updatedAt,
    storeId: staff.storeId, storeName: store?.name ?? null,
    staffRoleName: role?.name ?? null, permissions: (role?.permissions ?? []).filter((p: string) => (STAFF_PERMISSIONS as readonly string[]).includes(p)),
  };
}
