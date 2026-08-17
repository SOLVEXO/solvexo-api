import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetFeaturedDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isFeatured: boolean;
}
