/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** open = invoiced but unpaid, payment failed, or the invoice could not be created; the default view. */
export const FEE_BILL_FILTERS = ['open', 'awaiting_payment', 'payment_failed', 'invoiced', 'paid', 'all'] as const;

/** Body of "mark this fee bill as paid" (the money arrived by bank transfer). */
export class MarkFeeBillPaidDto {
  @ApiProperty({ required: false, description: 'Optional note, e.g. the transfer reference' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class TransactionFeeBillsQueryDto {
  @ApiProperty({ required: false, enum: FEE_BILL_FILTERS })
  @IsOptional()
  @IsIn(FEE_BILL_FILTERS)
  status?: string;

  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
