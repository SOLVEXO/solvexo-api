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
}
