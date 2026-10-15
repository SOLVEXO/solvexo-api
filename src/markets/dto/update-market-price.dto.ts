import { PartialType } from '@nestjs/swagger';
import { CreateMarketPriceDto } from './create-market-price.dto';

export class UpdateMarketPriceDto extends PartialType(CreateMarketPriceDto) {}
