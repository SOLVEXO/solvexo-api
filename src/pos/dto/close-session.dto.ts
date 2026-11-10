/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, IsOptional, Min } from 'class-validator';
import { IsArray, ValidateNested } from 'class-validator';
import { DenominationDto } from './open-session.dto';
import { Type } from 'class-transformer';

export class CloseSessionDto {
  @ApiProperty({ example: '664session1' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @ApiProperty({ example: 350, description: 'Physically counted cash at close' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  closingCash: number;

  @ApiProperty({ required: false, example: 1250.5, description: 'Card total printed on the terminal settlement slip. Optional: omitted → the shift closes as before, marked "not reconciled". A difference from the expected card total needs a manager PIN session.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cardTotalFromSlip?: number;

  @ApiProperty({ required: false, type: [Object], description: 'G4.6: the notes / coins counted at close, [{ valueMinor, count }]. When sent, their total must equal closingCash.' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DenominationDto)
  denominations?: DenominationDto[];
}
