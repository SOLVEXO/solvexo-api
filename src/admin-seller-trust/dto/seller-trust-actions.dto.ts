/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { NTN_CHECK_RESULTS } from '../../store/schemas/store.schema';
import { SellerTrustQueryDto } from './seller-trust-query.dto';

export class NtnCheckDto {
  @ApiProperty({ enum: NTN_CHECK_RESULTS, example: 'active' })
  @IsIn([...NTN_CHECK_RESULTS])
  result: (typeof NTN_CHECK_RESULTS)[number];
}

export class PayoutHoldDto {
  @ApiProperty({ example: true, description: 'true puts the hold on, false releases it' })
  @IsBoolean()
  active: boolean;

  @ApiProperty({ required: false, example: 'Chargebacks under investigation' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** Filter for a bulk reminder — the list filters without paging. */
export class RemindFilterDto extends SellerTrustQueryDto {}

export class RemindDto {
  @ApiProperty({ required: false, type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsString({ each: true })
  storeIds?: string[];

  @ApiProperty({ required: false, type: RemindFilterDto, description: 'Same filters as GET stores (page/limit ignored)' })
  @IsOptional() @ValidateNested() @Type(() => RemindFilterDto)
  filter?: RemindFilterDto;
}

export class UpdateSellerTrustSettingsDto {
  @ApiProperty({ required: false, nullable: true, enum: ['now'], description: '"now" starts enforcement (no-op if already started); null stops it' })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsIn(['now'])
  enforcementStartedAt?: 'now' | null;

  @ApiProperty({ required: false, example: 30 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365)
  graceDays?: number;
}
