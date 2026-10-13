/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { BlockInputDto } from '../../common/dto/block-input.dto';

export class UpdateHeaderDto {
  @ApiProperty({ required: false, enum: ['store', 'custom'] })
  @IsOptional() @IsIn(['store', 'custom'])
  logoSource?: 'store' | 'custom';

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  customLogoUrl?: string;

  @ApiProperty({ required: false, type: [BlockInputDto], description: 'nav_link blocks only' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto)
  blocks?: BlockInputDto[];

  @ApiProperty({ required: false, enum: ['left', 'center', 'right'] })
  @IsOptional() @IsIn(['left', 'center', 'right'])
  navAlignment?: string;

  @ApiProperty({ required: false, enum: ['standard', 'centered'] })
  @IsOptional() @IsIn(['standard', 'centered'])
  headerStyle?: string;

  @ApiProperty({ required: false, nullable: true, description: 'A Menu id to render instead of `blocks` — pass null to detach and fall back to `blocks` again.' })
  @IsOptional() @IsString()
  menuId?: string | null;

  @ApiProperty({ required: false, nullable: true, description: 'Logo width in px (null = theme default)' })
  @IsOptional() @IsInt() @Min(40) @Max(400)
  logoWidth?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsInt() @Min(24) @Max(240)
  mobileLogoWidth?: number | null;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() sticky?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showSearch?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showAccount?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showWishlist?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showShopMenu?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(24) shopMenuLabel?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() includePagesInNav?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showDefaultBlogLink?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(24) blogLinkLabel?: string | null;
}
