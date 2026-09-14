/* eslint-disable prettier/prettier */
import { PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateSupplierDto } from './create-supplier.dto';

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {
  @IsOptional() @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}
