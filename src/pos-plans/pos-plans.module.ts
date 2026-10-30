/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { PosPlansController } from './pos-plans.controller';
import { AdminPosPlansController } from './admin-pos-plans.controller';
import { PosPlansWebhookController } from './webhooks/pos-plans-webhook.controller';
import { PosPlansService } from './pos-plans.service';
import { AdminPosPlansService } from './admin-pos-plans.service';
import { PosPlansWebhookService } from './webhooks/pos-plans-webhook.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  // RedisModule alongside AuthModule is required by every module whose
  // controller uses JwtAuthGuard — the guard injects RedisService for its
  // session-revocation check, and that only resolves if this module's own
  // DI graph includes it (not implied by importing AuthModule alone).
  // Missing it causes a real, reproducible `TypeError: Cannot read
  // properties of undefined (reading 'isConnected')` 500 on every
  // authenticated route — same bug class already fixed for GiftCardsModule/
  // MetafieldsModule/MenusModule (see those modules' own doc comments).
  //
  // SubscriptionsModule is imported for its exported PaymentGatewayService —
  // reuses the same Stripe client setup as the platform-plans/buyer-facing
  // subscription billing rather than instantiating a second Stripe client.
  imports: [AuthModule, RedisModule, SubscriptionsModule],
  controllers: [PosPlansController, AdminPosPlansController, PosPlansWebhookController],
  providers: [PosPlansService, AdminPosPlansService, PosPlansWebhookService],
})
export class PosPlansModule {}
