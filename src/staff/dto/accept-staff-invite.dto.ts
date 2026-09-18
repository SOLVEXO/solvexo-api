import { IsString, MinLength } from 'class-validator';

export class AcceptStaffInviteDto {
  @IsString()
  @MinLength(8)
  password: string;
}
