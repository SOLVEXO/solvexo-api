/* eslint-disable prettier/prettier */
import { SetMetadata } from '@nestjs/common';
import type { FeatureFlagKey } from '../admin-config.service';

export const REQUIRE_FEATURE_KEY = 'requireFeature';

/** Gate a controller/route behind an admin-controlled feature flag — see FeatureFlagGuard. */
export const RequireFeature = (flag: FeatureFlagKey) => SetMetadata(REQUIRE_FEATURE_KEY, flag);
