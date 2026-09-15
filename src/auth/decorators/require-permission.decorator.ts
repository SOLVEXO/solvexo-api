/* eslint-disable prettier/prettier */
import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/** Gates a route for a `role:'staff'` caller (see StaffMember/
 *  PermissionsGuard) — a seller/admin caller always passes regardless of
 *  what's listed here (they own everything unconditionally; permissions
 *  only ever restrict a STAFF identity). Multiple permissions = "staff
 *  needs AT LEAST ONE of these", matching how `@Roles(...)` already reads
 *  as an OR-list in this codebase. */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permissions);
