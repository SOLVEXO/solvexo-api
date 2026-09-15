import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

// Sellers only — see AdminUsersService.list's doc comment for why buyers were
// removed from this page (a buyer is a global account, not owned by any one
// store; they're managed per-store instead, via
// StoreService.getStoreCustomersAdmin / setCustomerBlockedAdmin, or
// platform-wide via AdminUsersController's existing :role/:id routes when a
// buyer id is already known, e.g. from that per-store customer list).
export class AdminUsersQueryDto {
  @ApiProperty({ enum: ['active', 'suspended', 'pending'], required: false })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

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
