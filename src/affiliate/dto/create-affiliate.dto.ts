/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateAffiliateDto {
  @ApiProperty({ example: 'Jane Creator' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ required: false, enum: ['percentage', 'fixed'] })
  @IsOptional()
  @IsIn(['percentage', 'fixed'])
  commissionType?: 'percentage' | 'fixed';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionValue?: number;
}
