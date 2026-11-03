import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class ResetPinDto {
  @ApiProperty({ example: '1234', description: '4-digit numeric PIN (PIN-login requires exactly 4 digits)' })
  @IsString()
  @Length(4, 4, { message: 'PIN must be exactly 4 digits' })
  @Matches(/^\d+$/, { message: 'PIN must be numeric' })
  newPin: string;
}
