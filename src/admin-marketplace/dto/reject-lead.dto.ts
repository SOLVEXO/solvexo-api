import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectLeadDto {
  @ApiProperty({ required: false, example: 'Store name conflicts with an existing brand' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
