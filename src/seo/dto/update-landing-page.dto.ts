/* eslint-disable prettier/prettier */
import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateLandingPageDto } from './create-landing-page.dto';

// slug is immutable after creation — changing it would orphan/break any
// links or redirects already pointing at the page's URL.
export class UpdateLandingPageDto extends PartialType(OmitType(CreateLandingPageDto, ['slug'] as const)) {}
