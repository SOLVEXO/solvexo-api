import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
} from 'class-validator';

/** Sources a public caller may claim — 'seller' is only ever written
 *  server-side from the seller's own customer screen. */
export const PUBLIC_NEWSLETTER_SOURCES = [
  'platform_footer',
  'store_footer',
  'store_section',
  'checkout',
] as const;

export class SubscribeNewsletterDto {
  @ApiProperty({ example: 'buyer@example.com' })
  @IsEmail()
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @ApiPropertyOptional({
    description:
      "The store whose list to join. Omit for Solvexo's own platform list.",
  })
  @IsOptional()
  @IsMongoId()
  storeId?: string;

  @ApiPropertyOptional({ enum: PUBLIC_NEWSLETTER_SOURCES })
  @IsOptional()
  @IsIn(PUBLIC_NEWSLETTER_SOURCES)
  source?: (typeof PUBLIC_NEWSLETTER_SOURCES)[number];
}

export class SubscribeMeDto {
  @ApiPropertyOptional({
    description:
      "Required for an apex-wide buyer account; a store-scoped account's own store is used otherwise.",
  })
  @IsOptional()
  @IsMongoId()
  storeId?: string;
}
