import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, Matches, ValidateIf } from 'class-validator';

// If set, must contain the literal `{tracking}` placeholder — otherwise the
// template can never actually produce a real per-order tracking link.
const TRACKING_TEMPLATE_PATTERN = /\{tracking\}/;

export class CreateShippingCarrierDto {
  @ApiProperty({ example: 'TCS' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false, example: 'https://www.tcscourier.com/track/{tracking}' })
  @IsOptional()
  @ValidateIf((_, v) => !!v)
  @IsString()
  @Matches(TRACKING_TEMPLATE_PATTERN, { message: 'trackingUrlTemplate must contain a {tracking} placeholder' })
  trackingUrlTemplate?: string;
}

export class UpdateShippingCarrierDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateIf((_, v) => !!v)
  @IsString()
  @Matches(TRACKING_TEMPLATE_PATTERN, { message: 'trackingUrlTemplate must contain a {tracking} placeholder' })
  trackingUrlTemplate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
