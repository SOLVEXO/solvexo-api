/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'), 
    });
  }

async validate(payload: any) {
  return {
    userId: payload.sub,
    email: payload.email,
    role: payload.role || null,
    // Carried through so JwtAuthGuard can compare it against the account's
    // current DB value and reject a token issued before a suspend/deactivate.
    tokenVersion: payload.tokenVersion ?? 0,
    // Informational only for now (see User.storeId) — null/undefined for
    // seller/admin and for a legacy apex-wide buyer account. Required (and
    // authoritative — always this ONE store) for role:'staff'.
    storeId: payload.storeId ?? null,
    // Only ever set for role:'staff' — see StaffMember/PermissionsGuard.
    // Embedded directly in the token (not re-read from the DB per request)
    // so a permission change only takes effect after re-login, exactly like
    // every other tokenVersion-gated revocation in this app.
    permissions: payload.permissions ?? null,
    // Only ever set for role:'staff' — the OWNING seller's id (see
    // StaffMember.sellerId). Every Inventory/PurchaseOrders/StockCounts
    // controller passes THIS (not the staff member's own id) into the
    // exact same `sellerId`-scoped service methods a seller's own JWT
    // already uses — a store's real ownership check
    // (`storeModel.findOne({_id, sellerId})`) then passes for a staff
    // caller with zero service-layer changes, since a staff member's
    // owning seller IS that store's real sellerId.
    sellerId: payload.sellerId ?? null,
  };
}
}
