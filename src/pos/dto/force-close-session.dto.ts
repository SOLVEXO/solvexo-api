import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ForceCloseSessionDto {
  @ApiProperty({ required: false, example: 'System maintenance' })
  @IsOptional()
  @IsString()
  reason?: string;
}
