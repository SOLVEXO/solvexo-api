/* eslint-disable prettier/prettier */
import { IsEmail, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

export class GuestSessionDto {
  @IsMongoId() storeId: string;
}

export class GuestContactDto {
  @IsEmail() @MaxLength(254) email: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
}
