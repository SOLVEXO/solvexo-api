import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNumber, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ReorderOnboardingSlideItemDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order: number;
}

export class ReorderOnboardingSlidesDto {
  @ApiProperty({ type: [ReorderOnboardingSlideItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderOnboardingSlideItemDto)
  items: ReorderOnboardingSlideItemDto[];
}
