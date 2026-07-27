import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class ResetPinDto {
  @ApiProperty({ example: '1234', description: '4–6 digit numeric PIN' })
  @IsString()
  @Length(4, 6)
  @Matches(/^\d+$/, { message: 'PIN must be numeric' })
  newPin: string;
}
