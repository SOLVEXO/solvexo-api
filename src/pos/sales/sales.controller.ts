/* eslint-disable prettier/prettier */
import { Controller, Post, Body } from '@nestjs/common';
import { SalesService } from './sales.service';

@Controller('api/pos')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post('sale')
  async recordSale(@Body() body: any) {
    return this.salesService.recordSale(body);
  }
}
