/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { PartialType } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CreateStoreBannerDto } from './create-store-banner.dto';

export class UpdateStoreBannerDto extends PartialType(CreateStoreBannerDto) {
  // Needs its own real validator decorator (not just @ApiProperty, which is
  // Swagger-only metadata) now that the controller runs a real
  // ValidationPipe({ whitelist: true }) — class-validator's whitelist strips
  // any property with zero validator decorators regardless of whether the
  // class declares it, so without this, `update()`'s `{ ...dto }` spread
  // would silently stop persisting a banner's mobile image.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  mobileImageUrl?: string;
}
