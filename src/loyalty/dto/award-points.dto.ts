/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsNumber } from 'class-validator';

/** Manual credit/debit — covers birthday bonuses and referral awards until those systems are automated. */
export class AwardPointsDto {
  @ApiProperty({ example: 100 })
  @IsNumber()
  points: number;

  @ApiProperty({ enum: ['referral', 'birthday', 'adjustment'] })
  @IsEnum(['referral', 'birthday', 'adjustment'])
  type: 'referral' | 'birthday' | 'adjustment';

  @ApiProperty({ example: 'Birthday bonus' })
  @IsString()
  @IsNotEmpty()
  description: string;
}
