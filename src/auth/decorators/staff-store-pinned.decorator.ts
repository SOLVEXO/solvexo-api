/* eslint-disable prettier/prettier */
import { SetMetadata } from '@nestjs/common';

export const STAFF_STORE_PINNED_KEY = 'staffStorePinned';

/** For staff-enabled routes that take NO store identifier of their own (analytics, the cross-store order
 *  lists, the inbox list…). PermissionsGuard then pins a STAFF caller to their own store by injecting
 *  `query.storeId = user.storeId` when the request didn't send one — so such a route can never fall back to
 *  "every store of the owning seller". A seller/admin caller is unaffected. */
export const StaffStorePinned = () => SetMetadata(STAFF_STORE_PINNED_KEY, true);
