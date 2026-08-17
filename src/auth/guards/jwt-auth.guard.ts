/* eslint-disable prettier/prettier */
import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RedisService } from 'src/redis/redis.service';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly redisService: RedisService,
    private readonly databaseService: DatabaseService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {

    const can = (await super.canActivate(context)) as boolean;
    if (!can) return false;




    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.split(' ')[1];

    if (!token) {
      throw new UnauthorizedException('Token missing');
    }

    // Only enforce Redis session check when Redis is actually connected.
    // If Redis is down, Passport's JWT signature check (above) is sufficient.
    if (this.redisService.isConnected) {
      const isValid = await this.redisService.get(token);
      if (!isValid) {
        throw new UnauthorizedException('Session expired, please login again');
      }
    }

    // Session revocation: a suspend/deactivate action bumps the account's
    // tokenVersion in the DB. If this token's tokenVersion claim doesn't
    // match the current value, the token was issued before that action and
    // must be rejected immediately, regardless of its Redis/expiry state.
    const user = request.user;
    if (user?.userId && user?.role) {
      const model = this.modelForRole(user.role);
      if (model) {
        const account = await model
          .findById(user.userId)
          .select('tokenVersion')
          .lean();
        const currentTokenVersion = (account as any)?.tokenVersion ?? 0;
        if (!account || currentTokenVersion !== (user.tokenVersion ?? 0)) {
          throw new UnauthorizedException('Session revoked, please login again');
        }
      }
    }

    return true;
  }

  // Widened to `any` — User/Seller/Admin are structurally different Mongoose
  // models, and TS can't unify their overloaded `.findById()` signatures
  // into one callable type (same widening already used for this exact
  // cross-model situation in AdminUsersService.findOrThrow).
  private modelForRole(role: string): any {
    const repos = this.databaseService.repositories;
    if (role === 'user') return repos.userModel;
    if (role === 'seller') return repos.sellerModel;
    if (role === 'admin') return repos.adminModel;
    return null;
  }
}
