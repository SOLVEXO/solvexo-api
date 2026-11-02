/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AccountDeletionCron } from './account-deletion.cron';
import { SellerAccountDeletionController } from './seller-account-deletion.controller';
import { SellerAccountDeletionService } from './seller-account-deletion.service';
import { PosTokenRevocationService } from '../pos/pos-token-revocation.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [SellerAccountDeletionController],
  providers: [SellerAccountDeletionService, AccountDeletionCron, PosTokenRevocationService],
})
export class AccountDeletionModule {}
