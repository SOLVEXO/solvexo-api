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

    console.log('Token from header:', token); // Debug log

    if (!token) {
      throw new UnauthorizedException('Token missing');
    }

    const isValid = await this.redisService.get(token);
     console.log(isValid); 
    if (!isValid) {
      throw new UnauthorizedException('Session expired, please login again');
    }

    return true;
  }
}
