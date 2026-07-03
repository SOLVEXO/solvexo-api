/* eslint-disable prettier/prettier */
import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RedisService } from 'src/redis/redis.service';

// Same checks as JwtAuthGuard, but never blocks the request — an anonymous
// visitor gets req.user = null instead of a 401. Used by public endpoints
// that want to personalize the response *if* the caller happens to be logged in
// (e.g. flagging "this is your own review") without requiring login.
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly redisService: RedisService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = request.headers.authorization?.split(' ')[1];
    if (!token) return true;

    try {
      await super.canActivate(context);
      if (this.redisService.isConnected) {
        const isValid = await this.redisService.get(token);
        if (!isValid) request.user = null;
      }
    } catch {
      request.user = null;
    }
    return true;
  }

  handleRequest(_err: any, user: any) {
    return user || null;
  }
}
