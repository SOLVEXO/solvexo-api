/* eslint-disable prettier/prettier */
import { IsNotEmpty, IsString } from 'class-validator';

export class RemoveDeviceTokenDto {
  @IsString()
  @IsNotEmpty()
  fcmToken: string;
}
