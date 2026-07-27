import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class RedeemRewardDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  rewardId: string;
}
