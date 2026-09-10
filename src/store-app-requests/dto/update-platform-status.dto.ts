/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';
import { STORE_APP_PLATFORM_STATUSES, StoreAppPlatformStatus } from '../schemas/store-app-request.schema';

export class UpdatePlatformStatusDto {
  @ApiProperty({ enum: ['android', 'ios'] })
  @IsIn(['android', 'ios'])
  platform: 'android' | 'ios';

  @ApiProperty({ enum: STORE_APP_PLATFORM_STATUSES })
  @IsIn(STORE_APP_PLATFORM_STATUSES)
  status: StoreAppPlatformStatus;

  // Only meaningful (and required by the service) when status === 'published'.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl({}, { message: 'storeUrl must be a valid URL' })
  storeUrl?: string;

  // Only meaningful when status === 'rejected'.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  rejectionReason?: string;

  @ApiProperty({ required: false, description: 'Internal note, never shown to the seller' })
  @IsOptional()
  @IsString()
  adminNotes?: string;
}
