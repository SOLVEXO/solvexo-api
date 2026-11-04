import { IsMongoId, IsOptional } from 'class-validator';

export class CarryContentDto {
  /** Installed theme to copy the content from; default = the store's currently active theme. */
  @IsOptional() @IsMongoId() fromInstalledThemeId?: string;
}
