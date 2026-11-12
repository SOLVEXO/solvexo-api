/* eslint-disable prettier/prettier */
import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { parseCspReports } from './csp-report.util';

/**
 * Receives Content-Security-Policy violation reports from browsers (the web app sends its Report-Only policy here), so the
 * policy can be tuned and then enforced without breaking storefront pixels or payment pages. Logged as one short line per
 * violation; nothing is stored. Public by design (browsers send these without credentials), rate limited.
 */
@ApiExcludeController()
@Controller('api/security')
export class CspReportController {
  private readonly logger = new Logger('CSP');

  @Post('csp-report')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  report(@Body() body: unknown): void {
    for (const v of parseCspReports(body)) {
      this.logger.warn(`csp ${v.disposition} ${v.directive} blocked=${v.blocked || '-'} page=${v.page || '-'}`);
    }
  }
}
