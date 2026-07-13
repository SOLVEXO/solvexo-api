/* eslint-disable prettier/prettier */
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsOptional, IsEnum } from 'class-validator';
import { CreateStoreLocationDto } from './create-store-location.dto';

export class UpdateStoreLocationDto extends PartialType(CreateStoreLocationDto) {
  @ApiProperty({ required: false, enum: ['active', 'archived'] })
  @IsOptional() @IsEnum(['active', 'archived'])
  status?: string;
}
