import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { VERIFICATION_STATUSES } from '../../store/schemas/store.schema';

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

  // Accepted for clarity (`?role=seller`) — this list is sellers only anyway.
  @ApiProperty({ required: false, enum: ['seller'] })
  @IsOptional()
  @IsIn(['seller'])
  role?: 'seller';

  // Seller-trust filters — a seller matches when ANY of their stores matches all of them.
  @ApiProperty({ required: false, example: 'PK' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiProperty({ required: false, enum: ['yes', 'no'] })
  @IsOptional()
  @IsIn(['yes', 'no'])
  ntn?: 'yes' | 'no';

  @ApiProperty({ required: false, enum: VERIFICATION_STATUSES })
  @IsOptional()
  @IsIn([...VERIFICATION_STATUSES])
  verification?: string;

  @ApiProperty({ required: false, enum: ['low', 'medium', 'high'] })
  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  risk?: 'low' | 'medium' | 'high';

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
