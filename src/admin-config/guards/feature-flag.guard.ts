/* eslint-disable prettier/prettier */
import { Injectable, CanActivate, ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminConfigService } from '../admin-config.service';
import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly adminConfigService: AdminConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flag = this.reflector.getAllAndOverride<string>(REQUIRE_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flag) return true; // no @RequireFeature() on this route

    const enabled = await this.adminConfigService.isFeatureEnabled(flag as any);
    if (!enabled) {
      throw new ServiceUnavailableException(`This feature ("${flag}") is currently disabled by the platform.`);
    }
    return true;
  }
}
