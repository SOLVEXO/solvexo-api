import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { FinanceModule } from 'src/finance/finance.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';

@Module({
  imports: [AuthModule, RedisModule, FinanceModule, AdminConfigModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
