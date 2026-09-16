import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { STAFF_PERMISSIONS } from '../schemas/staff-member.schema';

export class CreateRoleDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @IsIn(STAFF_PERMISSIONS as any, { each: true })
  permissions: string[];
}
