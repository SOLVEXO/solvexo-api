/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsNumber, IsString, Min, Max, MaxLength } from 'class-validator';

export class UpdateAbandonedCartSettingsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false, description: 'Designed first email (EmailDesign JSON); null goes back to the plain text' })
  @IsOptional()
  @IsObject()
  design?: Record<string, unknown> | null;

  @ApiProperty({ required: false, description: 'The rendered HTML of `design`' })
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  html?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  secondDesign?: Record<string, unknown> | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  secondHtml?: string | null;

  @ApiProperty({ required: false, enum: ['subscribed', 'all'] })
  @IsOptional()
  @IsIn(['subscribed', 'all'])
  audience?: 'subscribed' | 'all';

  @ApiProperty({ required: false, example: 60 })
  @IsOptional()
  @IsNumber()
  @Min(5)
  delayMinutes?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  /** An existing coupon code of the store, or an empty string / null to remove it. Verified against the store's coupons on save. */
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  discountCode?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  secondReminderEnabled?: boolean;

  @ApiProperty({ required: false, example: 24 })
  @IsOptional()
  @IsNumber()
  @Min(6)
  @Max(168)
  secondReminderDelayHours?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secondSubject?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  secondMessage?: string;
}
