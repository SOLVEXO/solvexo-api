import { IsIn, IsOptional, IsString } from 'class-validator';
import { STAFF_ROLES } from '../schemas/staff-member.schema';

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(STAFF_ROLES as any)
  role?: string;

  @IsOptional()
  @IsString()
  roleId?: string;

  @IsOptional()
  @IsString()
  locationId?: string | null;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;
}
