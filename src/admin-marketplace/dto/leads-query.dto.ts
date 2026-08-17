import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { VERIFICATION_STATUSES } from '../../store/schemas/store.schema';

export class LeadsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, enum: [...VERIFICATION_STATUSES, 'all'], description: 'Omit for the default pending/under_review review queue; "all" removes the status filter entirely.' })
  @IsOptional()
  @IsIn([...VERIFICATION_STATUSES, 'all'])
  verificationStatus?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
