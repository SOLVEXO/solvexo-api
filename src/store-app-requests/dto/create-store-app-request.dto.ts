/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Just the app's profile/listing details — free to submit. Android/iOS are
// each requested (and paid for) separately afterward, one platform at a
// time, via StoreAppRequestsService.createPlatformPaymentIntent /
// confirmPlatformPayment — this DTO no longer carries platform booleans.
export class CreateStoreAppRequestDto {
  @ApiProperty({ example: 'My Store' })
  @IsString()
  @IsNotEmpty({ message: 'App name is required' })
  @MaxLength(50)
  appName: string;

  @ApiProperty({ example: 'Shop My Store on the go.' })
  @IsString()
  @IsNotEmpty({ message: 'Short description is required' })
  @MaxLength(80, { message: 'Short description must be 80 characters or fewer (Google Play limit)' })
  shortDescription: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Full description is required' })
  @MaxLength(4000, { message: 'Full description must be 4000 characters or fewer (Google Play limit)' })
  fullDescription: string;
}
