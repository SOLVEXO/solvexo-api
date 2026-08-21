import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCustomCssDto {
  @ApiProperty({ nullable: true, required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  customCss?: string | null;
}
