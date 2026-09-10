import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetThemeFeaturedDto {
  @ApiProperty() @IsBoolean() featured: boolean;
}
