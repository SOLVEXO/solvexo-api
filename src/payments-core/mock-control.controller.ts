/* eslint-disable prettier/prettier */
import { Body, Controller, ForbiddenException, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PosAuthGuard } from '../pos/guards/pos-auth.guard';
import { PAYMENT_PROVIDERS, PaymentProvider } from './payment-provider.interface';
import { MockPaymentProvider } from './providers/mock.provider';
import { PaymentsCoreService } from './payments-core.service';
import { PaymentsWebhookService } from './payments-webhook.service';

export class MockSimulateDto {
  @IsString() intentId: string;
  @IsIn(['confirm', 'fail', 'expire']) scenario: 'confirm' | 'fail' | 'expire';
  @IsOptional() @IsIn(['webhook', 'none']) deliver?: 'webhook' | 'none';
}

/**
 * Demo / test control for the MOCK provider only ("customer paid" button in debug builds). Hard-disabled in production and whenever the
 * active provider is not the mock: the route answers 403 and the mock provider is not even registered when NODE_ENV=production.
 */
@ApiTags('POS payments (mock control)')
@Controller('api/pos/payments/mock')
export class MockControlController {
  constructor(
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProvider[],
    private readonly core: PaymentsCoreService,
    private readonly webhooks: PaymentsWebhookService,
  ) {}

  @ApiExcludeEndpoint()
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('simulate')
  async simulate(@Body() dto: MockSimulateDto) {
    const mock = this.providers.find((p) => p.key === 'mock') as MockPaymentProvider | undefined;
    if (process.env.NODE_ENV === 'production' || !mock || process.env.PAYMENTS_MOCK_CONTROL !== 'true') throw new ForbiddenException('Mock payment control is disabled');
    const intent: any = await this.core.intents.findById(dto.intentId).lean();
    if (!intent || intent.providerKey !== 'mock') throw new ForbiddenException('Not a mock payment');
    mock.simulate(intent.providerRef, dto.scenario);
    if ((dto.deliver ?? 'webhook') === 'webhook') {
      const w = mock.buildWebhook({ kind: dto.scenario === 'confirm' ? 'confirmed' : dto.scenario === 'fail' ? 'failed' : 'expired', providerRef: intent.providerRef, amountMinor: intent.amountMinor });
      await this.webhooks.receive('mock', w.body, w.headers);
    }
    return { success: true };
  }
}
