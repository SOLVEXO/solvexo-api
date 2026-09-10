/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { PosPlansController } from './pos-plans.controller';
import { AdminPosPlansController } from './admin-pos-plans.controller';
import { PosPlansWebhookController } from './webhooks/pos-plans-webhook.controller';
import { PosPlansService } from './pos-plans.service';
import { AdminPosPlansService } from './admin-pos-plans.service';
import { PosPlansWebhookService } from './webhooks/pos-plans-webhook.service';
import { AuthModule } from '../auth/auth.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  // SubscriptionsModule is imported for its exported PaymentGatewayService —
  // reuses the same Stripe client setup as the platform-plans/buyer-facing
  // subscription billing rather than instantiating a second Stripe client.
  imports: [AuthModule, SubscriptionsModule],
  controllers: [PosPlansController, AdminPosPlansController, PosPlansWebhookController],
  providers: [PosPlansService, AdminPosPlansService, PosPlansWebhookService],
})
export class PosPlansModule {}
