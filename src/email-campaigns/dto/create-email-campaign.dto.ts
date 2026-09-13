/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateEmailCampaignDto {
  @ApiProperty({ example: 'September clearance blast' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: '20% off everything this weekend only' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject: string;

  @ApiProperty({ example: 'Hi {{customerName}}, ...' })
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiProperty({ enum: ['all', 'buyers', 'abandoned'] })
  @IsIn(['all', 'buyers', 'abandoned'])
  audience: 'all' | 'buyers' | 'abandoned';
}
