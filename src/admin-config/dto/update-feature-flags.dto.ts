/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateFeatureFlagsDto {
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() aiStudio?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() marketplace?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() digitalUploads?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() affiliateProgram?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() giftCards?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() posMode?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() storeBuilder?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() bulkProductImport?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() promotions?: boolean;
}
