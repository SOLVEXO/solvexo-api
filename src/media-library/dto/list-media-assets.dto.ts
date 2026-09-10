/* eslint-disable prettier/prettier */
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListMediaAssetsDto {
  @IsOptional() @IsString()
  search?: string;

  // 'raw' = Cloudinary's bucket for everything that isn't an image or video
  // (PDF, Word/Excel/PowerPoint, zip, plain text — see UploadService's own
  // `getResourceType`) — the Files Library's "Files" filter tab.
  @IsOptional() @IsIn(['image', 'video', 'raw'])
  type?: 'image' | 'video' | 'raw';

  @IsOptional() @IsString()
  tag?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}
