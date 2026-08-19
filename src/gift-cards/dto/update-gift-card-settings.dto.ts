/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsArray, IsNumber, Min, ArrayMinSize } from 'class-validator';

export class UpdateGiftCardSettingsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  purchaseEnabled?: boolean;

  @ApiProperty({ required: false, example: [10, 25, 50, 100] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsNumber({}, { each: true })
  denominations?: number[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  neverExpires?: boolean;

  @ApiProperty({ required: false, example: 12 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  expiryMonths?: number;
}
