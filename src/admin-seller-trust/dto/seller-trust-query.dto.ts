/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { VERIFICATION_STATUSES } from '../../store/schemas/store.schema';

export class SellerTrustQueryDto {
  @ApiProperty({ required: false, description: 'Store name/slug, seller name/email/phone, NTN or CNIC' })
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @ApiProperty({ required: false, example: 'PK', description: 'ISO alpha-2. PK also matches stores with no country (they default to Pakistan).' })
  @IsOptional() @IsString() @MaxLength(2)
  country?: string;

  @ApiProperty({ required: false, enum: ['yes', 'no'] })
  @IsOptional() @IsIn(['yes', 'no'])
  ntn?: 'yes' | 'no';

  @ApiProperty({ required: false, enum: VERIFICATION_STATUSES })
  @IsOptional() @IsIn([...VERIFICATION_STATUSES])
  status?: string;

  @ApiProperty({ required: false, enum: ['low', 'medium', 'high'] })
  @IsOptional() @IsIn(['low', 'medium', 'high'])
  risk?: 'low' | 'medium' | 'high';

  @ApiProperty({ required: false, enum: ['yes', 'no'] })
  @IsOptional() @IsIn(['yes', 'no'])
  limited?: 'yes' | 'no';

  @ApiProperty({ required: false, enum: ['submitted', 'risk', 'created'], default: 'submitted' })
  @IsOptional() @IsIn(['submitted', 'risk', 'created'])
  sort?: 'submitted' | 'risk' | 'created';

  @ApiProperty({ required: false, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;
}
