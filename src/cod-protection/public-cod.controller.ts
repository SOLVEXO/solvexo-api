/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { CodConfirmationService } from './cod-confirmation.service';

/** Public (no login): the buyer opens the link from the confirmation message. Each call acts on the ONE order the signed link names. */
@ApiTags('COD confirmation (public)')
@Controller('api/public/cod')
export class PublicCodController {
  constructor(private readonly svc: CodConfirmationService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  view(@Param('token') token: string) { return this.svc.publicView(token); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/confirm')
  confirm(@Param('token') token: string) { return this.svc.confirm(token); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/cancel')
  cancel(@Param('token') token: string) { return this.svc.cancel(token); }
}
