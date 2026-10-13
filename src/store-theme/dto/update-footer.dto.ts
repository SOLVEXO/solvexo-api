/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { BlockInputDto } from '../../common/dto/block-input.dto';

export class UpdateFooterDto {
  @ApiProperty({ type: [BlockInputDto], description: 'footer_column / social_link / copyright_text blocks' })
  @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto)
  blocks: BlockInputDto[];

  @ApiProperty({ required: false, enum: ['columns', 'minimal'] })
  @IsOptional() @IsIn(['columns', 'minimal'])
  footerStyle?: string;

  @ApiProperty({ required: false, nullable: true, description: "A Menu id whose items become one synthetic footer_column block (heading = the menu's name) alongside the footer's own social_link/copyright_text blocks — pass null to detach." })
  @IsOptional() @IsString()
  menuId?: string | null;

  @ApiProperty({ required: false, enum: ['none', 'store', 'custom'] })
  @IsOptional() @IsIn(['none', 'store', 'custom'])
  logoSource?: 'none' | 'store' | 'custom';

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(2048) logoUrl?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsInt() @Min(40) @Max(400)
  logoWidth?: number | null;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showNewsletter?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(60) newsletterHeading?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(160) newsletterText?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showDefaultColumns?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) shopColumnHeading?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) accountColumnHeading?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(24) blogLinkLabel?: string | null;
}
