import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RequestInfoDto {
  // Shown to the seller on their verification page, so it must say what to fix.
  @ApiProperty({ example: 'Please upload a clearer photo of the back of your CNIC' })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(1000)
  message: string;
}
