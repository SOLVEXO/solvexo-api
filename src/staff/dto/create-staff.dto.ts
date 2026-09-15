import { IsArray, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { STAFF_PERMISSIONS, STAFF_ROLES } from '../schemas/staff-member.schema';

export class CreateStaffDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsIn(STAFF_ROLES as any)
  role?: string;

  @IsOptional()
  @IsArray()
  @IsIn(STAFF_PERMISSIONS as any, { each: true })
  permissions?: string[];

  @IsOptional()
  @IsString()
  locationId?: string;
}
