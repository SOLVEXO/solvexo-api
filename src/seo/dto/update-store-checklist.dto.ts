/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsBoolean } from 'class-validator';

export class UpdateStoreChecklistItemDto {
  @ApiProperty({ example: 'sitemap_submitted' })
  @IsString() @IsNotEmpty()
  key: string;

  @ApiProperty()
  @IsBoolean()
  done: boolean;
}
