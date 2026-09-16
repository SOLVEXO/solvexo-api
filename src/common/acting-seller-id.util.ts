/* eslint-disable prettier/prettier */

/** A staff JWT carries its OWNING seller's id as `sellerId` (see
 *  JwtStrategy's doc comment) — every staff-enabled controller passes THIS
 *  into a service's existing `sellerId`-scoped methods unchanged, so a
 *  store-ownership check written for a seller's own JWT also correctly
 *  passes for a staff caller acting on that same store. A seller/admin
 *  caller's own `userId` IS already that value. Shared here (previously
 *  duplicated per-controller) since this exact one-liner is now used
 *  across every staff-enabled controller, not just Inventory's original 3. */
export function actingSellerId(user: any): string {
  return user.role === 'staff' ? user.sellerId : user.userId;
}
