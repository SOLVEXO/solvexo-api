/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { PosModule } from '@/pos/pos.module';
import { KybModule } from '@/kyb/kyb.module';
import { KybGateService } from '@/kyb/kyb-gate.service';
import { Store, StoreSchema } from '@/store/schemas/store.schema';
import { RegisterSession, RegisterSessionSchema } from '@/pos/schemas/register-session.schema';
import { Sale, SaleSchema } from '@/pos/schemas/sales.schema';
import { PosAuditLog, PosAuditLogSchema } from '@/pos/schemas/pos-audit-log.schema';
import {
  PaymentEvent, PaymentEventSchema, PaymentIntent, PaymentIntentSchema, PaymentWebhookInbox, PaymentWebhookInboxSchema,
  PaymentWebhookOutcome, PaymentWebhookOutcomeSchema,
} from './schemas/payments.schemas';
import { PAYMENT_PROVIDERS, PaymentProvider } from './payment-provider.interface';
import { MockPaymentProvider } from './providers/mock.provider';
import { DIGITAL_PAYMENTS_GATE } from './digital-payments-gate';
import { PaymentsCoreService } from './payments-core.service';
import { PaymentsWebhookService } from './payments-webhook.service';
import { PaymentsPollerService } from './payments-poller.service';
import { PaymentsCoreController } from './payments-core.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { MockControlController } from './mock-control.controller';

/** Providers registered at boot. The mock is never registered in production; a real adapter is added here when its contract tests pass. */
export function buildProviders(env: NodeJS.ProcessEnv = process.env): PaymentProvider[] {
  const list: PaymentProvider[] = [];
  if (env.NODE_ENV !== 'production') {
    list.push(new MockPaymentProvider({ webhookSecret: env.PAYMENTS_MOCK_WEBHOOK_SECRET || 'mock-webhook-secret-dev-only', supportsWebhooks: env.PAYMENTS_MOCK_WEBHOOKS !== 'false' }));
  }
  return list;
}

@Module({
  imports: [
    AuthModule, RedisModule, AdminConfigModule, PosModule, KybModule,
    MongooseModule.forFeature([
      { name: PaymentIntent.name, schema: PaymentIntentSchema },
      { name: PaymentEvent.name, schema: PaymentEventSchema },
      { name: PaymentWebhookInbox.name, schema: PaymentWebhookInboxSchema },
      { name: PaymentWebhookOutcome.name, schema: PaymentWebhookOutcomeSchema },
      { name: Store.name, schema: StoreSchema },
      { name: RegisterSession.name, schema: RegisterSessionSchema },
      { name: Sale.name, schema: SaleSchema },
      { name: PosAuditLog.name, schema: PosAuditLogSchema },
    ]),
  ],
  controllers: [PaymentsCoreController, PaymentsWebhookController, MockControlController],
  providers: [
    PaymentsCoreService, PaymentsWebhookService, PaymentsPollerService,
    { provide: PAYMENT_PROVIDERS, useFactory: () => buildProviders() },
    { provide: DIGITAL_PAYMENTS_GATE, useExisting: KybGateService },
  ],
  exports: [PaymentsCoreService, DIGITAL_PAYMENTS_GATE],
})
export class PaymentsCoreModule {}
