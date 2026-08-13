/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { BlockInputDto } from '../../common/dto/block-input.dto';

export class UpdateBlogContentDto {
  @ApiProperty({ type: [BlockInputDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto)
  content: BlockInputDto[];
}
