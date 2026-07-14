/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class BulkApplyProductTemplateDto {
  @ApiProperty({ required: false, example: '{{productName}} | My Store' })
  @IsOptional() @IsString()
  titleTemplate?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  descriptionTemplate?: string;

  @ApiProperty({ required: false, description: 'Limit to products in this category' })
  @IsOptional() @IsString()
  categoryId?: string;

  @ApiProperty({ required: false, description: 'Only apply to products with no existing meta title' })
  @IsOptional() @IsBoolean()
  onlyMissing?: boolean;
}
