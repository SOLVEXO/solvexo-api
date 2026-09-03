/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class MetafieldValueInput {
  @ApiProperty() @IsString()
  namespace: string;

  @ApiProperty() @IsString()
  key: string;

  // Validated for real against the matching MetafieldDefinition's `type` in
  // the service (empty string / omission there means "clear this value" —
  // see `MetafieldsService.setValues`), not here — `class-validator` has no
  // way to know which definition a given {namespace,key} pair resolves to.
  @ApiProperty()
  @IsString()
  value: string;
}

export class SetValuesDto {
  @ApiProperty({ type: [MetafieldValueInput] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetafieldValueInput)
  values: MetafieldValueInput[];
}
