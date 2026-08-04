import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RejectLeadDto {
  // Mandatory — a rejection with no explanation leaves the seller with
  // nothing to correct before resubmitting.
  @ApiProperty({ example: 'Business registration document is illegible — please re-upload a clearer scan' })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
