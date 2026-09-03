/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
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
}
