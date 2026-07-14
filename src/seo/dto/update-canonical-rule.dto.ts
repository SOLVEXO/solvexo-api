/* eslint-disable prettier/prettier */
import { PartialType } from '@nestjs/swagger';
import { CreateCanonicalRuleDto } from './create-canonical-rule.dto';

export class UpdateCanonicalRuleDto extends PartialType(CreateCanonicalRuleDto) {}
