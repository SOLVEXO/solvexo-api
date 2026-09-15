import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

// Query shape for AdminUsersController's `GET stores/:storeId/customers` —
// deliberately a small subset of what the seller-facing Customers page
// supports (StoreService.getStoreCustomers takes search/segment/dateFrom/
// dateTo/sortBy/sortDir/view too), since the admin panel only needs to find
// and act on one buyer at a time, not run a full storefront CRM.
export class StoreCustomersQueryDto {
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
