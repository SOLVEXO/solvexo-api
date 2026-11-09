import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { RedisModule } from '@/redis/redis.module';
import { AuthModule } from '@/auth/auth.module';

@Module({
  imports: [RedisModule, AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
