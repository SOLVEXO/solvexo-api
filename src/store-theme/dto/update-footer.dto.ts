/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
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
}
