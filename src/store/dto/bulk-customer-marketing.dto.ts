/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsString } from 'class-validator';

export class BulkCustomerMarketingDto {
  @ApiProperty({ type: [String], description: 'Customer ids; a subscriber-only row id is `sub:<subscriberId>`.' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  customerIds: string[];

  @ApiProperty({ description: 'true = subscribe to email marketing, false = unsubscribe.' })
  @IsBoolean()
  subscribed: boolean;
}
