/* eslint-disable prettier/prettier */
import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { buildOpenApiSpec } from './merchant-api.openapi';

/**
 * Public (no token): the OpenAPI description of the Admin API, so partners, Zapier and SDK generators can read it.
 * It describes the API only; it holds no store data. Listed in common/route-auth-scan.spec.ts PUBLIC_FILES.
 */
@ApiExcludeController()
@Controller('api/merchant/v1')
export class MerchantApiDocsController {
  private readonly spec = buildOpenApiSpec();

  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=300')
  @Header('Access-Control-Allow-Origin', '*')
  openapi() { return this.spec; }
}
