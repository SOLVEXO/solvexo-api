/* eslint-disable prettier/prettier */
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

/** Date range + kind filter for the billing timeline / statement. `kinds` is a comma-separated list, e.g. "payment,refund". */
export class BillingTimelineQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @MaxLength(200) kinds?: string;
}
