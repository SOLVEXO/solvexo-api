/* eslint-disable prettier/prettier */
import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly redisService: RedisService) {
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

    return true;
  }
}
