/* eslint-disable prettier/prettier */
import { PartialType } from '@nestjs/swagger';
import { CreateThemeDefinitionDto } from './create-theme-definition.dto';

export class UpdateThemeDefinitionDto extends PartialType(CreateThemeDefinitionDto) {}
