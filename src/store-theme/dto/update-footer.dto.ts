/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { BlockInputDto } from '../../common/dto/block-input.dto';

export class UpdateFooterDto {
  @ApiProperty({ type: [BlockInputDto], description: 'footer_column / social_link / copyright_text blocks' })
  @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto)
  blocks: BlockInputDto[];

  @ApiProperty({ required: false, enum: ['columns', 'minimal'] })
  @IsOptional() @IsIn(['columns', 'minimal'])
  footerStyle?: string;
}
