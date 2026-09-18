import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import { STAFF_ROLES } from '../schemas/staff-member.schema';

// No `password` field — the seller never sets a staff member's password.
// `create()` emails a real invite link instead; the staff member sets
// their own password by accepting it (see AcceptStaffInviteDto).
export class CreateStaffDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsIn(STAFF_ROLES as any)
  role?: string;

  @IsOptional()
  @IsString()
  roleId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;
}
