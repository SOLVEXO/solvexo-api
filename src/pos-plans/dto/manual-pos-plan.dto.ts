import { IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Shared by grant and extend: a store, a number of days, and a mandatory audited reason. */
export class GrantPosPlanDto {
  @IsMongoId()
  storeId: string;

  @IsInt()
  @Min(1)
  @Max(3650)
  days: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  /** Optional: attach the grant to a catalog plan (name snapshot); omitted → "Manual grant". */
  @IsOptional()
  @IsMongoId()
  planId?: string;
}

export class RevokePosPlanDto {
  @IsMongoId()
  storeId: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
