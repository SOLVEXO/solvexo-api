import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsNumber, Min } from 'class-validator';

export class UpdateEarningRulesDto {
  @ApiProperty({ required: false, description: 'Points earned per $1 spent' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pointsPerDollar?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pointsPerReview?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pointsPerReferral?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  birthdayBonusPoints?: number;
}
