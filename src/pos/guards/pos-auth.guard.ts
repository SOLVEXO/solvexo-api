/* eslint-disable prettier/prettier */
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RedisService } from '@/redis/redis.service';
import { DatabaseService } from '@/database/databaseservice';
import { PosDeviceService, POS_DEVICE_TOKEN_TYPE } from '../pos-device.service';
import { PosTokenRevocationService } from '../pos-token-revocation.service';

/** Route needs a verified MANAGER PIN session when the caller is a device (owner/staff JWTs are unaffected). */
export const REQUIRE_MANAGER_PIN = 'posRequireManagerPin';
export const RequireManagerPin = () => SetMetadata(REQUIRE_MANAGER_PIN, true);

/**
 * Auth for the POS operational routes. Accepts EITHER the owner/staff JWT (existing web/legacy behaviour, unchanged)
 * OR a POS device token. A device is presented to the rest of the stack as the owning seller (`role:'seller'`,
 * `userId: sellerId`) so the existing `@Roles` / `actingSellerId` / ownership checks work — but it is pinned to its
 * ONE store: any storeId in the path/query/body that differs is refused, and PosService's ownership check enforces the
 * same for routes that resolve the store from a saleId/sessionId (see pos-device-scope.ts). Device tokens are NOT
 * accepted by JwtAuthGuard, so they cannot reach anything outside the routes that opt in to this guard.
 */
@Injectable()
export class PosAuthGuard extends JwtAuthGuard {
  private readonly devices: PosDeviceService;
  private readonly revocations: PosTokenRevocationService;

  // Built from the same two providers JwtAuthGuard already needs, so any module that can use JwtAuthGuard can use this
  // one with no extra wiring (inventory, pos-plans … each import RedisModule already).
  constructor(redis: RedisService, db: DatabaseService, private readonly reflector: Reflector) {
    super(redis, db);
    this.devices = new PosDeviceService(db);
    this.revocations = new PosTokenRevocationService(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const bearer: string | undefined = req.headers?.authorization?.split(' ')[1];
    const peek: any = bearer ? jwt.decode(bearer) : null;
    if (peek?.type !== POS_DEVICE_TOKEN_TYPE) {
      const ok = await super.canActivate(context);
      // Legacy sunset: once every install has been moved to device tokens, POS_LEGACY_AUTH_ALLOWED=false makes the POS
      // routes refuse owner/staff JWTs with a distinct code (403, NOT 401, so clients don't treat it as a dead session).
      // The app answers by forcing device setup, keeping the cart and the offline queue.
      if (ok && process.env.POS_LEGACY_AUTH_ALLOWED === 'false') {
        throw new ForbiddenException({ statusCode: 403, code: 'POS_LEGACY_AUTH_DISABLED', message: 'This POS install must be set up as a registered device' });
      }
      return ok;
    }

    const device = await this.devices.verifyToken(bearer!, req.ip);
    const asked = [req.params?.storeId, req.query?.storeId, req.body?.storeId].filter((v) => typeof v === 'string' && v);
    if (asked.some((s) => s !== device.storeId)) {
      throw new ForbiddenException({ statusCode: 403, code: 'POS_DEVICE_WRONG_STORE', message: 'This device is registered to a different store' });
    }
    // A session is opened on THIS device's register only (synced sales may carry another register of the same store).
    if (/\/sessions\/open\/?$/.test(req.originalUrl?.split('?')[0] ?? '') && req.body?.registerId && String(req.body.registerId) !== device.registerId) {
      throw new ForbiddenException({ statusCode: 403, code: 'POS_DEVICE_WRONG_REGISTER', message: 'This device is registered to a different register' });
    }
    req.user = { userId: device.sellerId, role: 'seller', tokenVersion: 0, storeId: device.storeId, posDevice: device };

    const needsManager = this.reflector.getAllAndOverride<boolean>(REQUIRE_MANAGER_PIN, [context.getHandler(), context.getClass()]);
    if (needsManager) {
      const empToken = req.headers?.['x-pos-employee-token'];
      let p: any = null;
      try { p = typeof empToken === 'string' ? jwt.verify(empToken, process.env.JWT_SECRET as string) : null; } catch { /* below */ }
      if (!p || p.type !== 'pos_employee' || p.role !== 'manager' || p.storeId !== device.storeId || (await this.revocations.isRevoked(p))) {
        throw new ForbiddenException({ statusCode: 403, code: 'MANAGER_PIN_REQUIRED', message: 'A manager PIN session is required for this' });
      }
    }
    return true;
  }
}
