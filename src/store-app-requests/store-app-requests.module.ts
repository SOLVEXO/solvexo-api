import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { EmailService } from '../otp/services/email.service';
import { StoreAppRequestsController } from './store-app-requests.controller';
import { AdminStoreAppRequestsController } from './admin-store-app-requests.controller';
import { StoreAppRequestsService } from './store-app-requests.service';

@Module({
  imports: [AuthModule, RedisModule, UploadModule],
  controllers: [StoreAppRequestsController, AdminStoreAppRequestsController],
  providers: [StoreAppRequestsService, EmailService],
  exports: [StoreAppRequestsService],
})
export class StoreAppRequestsModule {}
