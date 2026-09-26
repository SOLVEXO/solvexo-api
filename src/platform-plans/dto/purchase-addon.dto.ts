/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Every add-on type that has EVER been sold — kept so historical
 *  PlatformAddonPurchase rows (and the schema enum) stay valid. */
export const ADDON_TYPES = [
  'extra_ai_credits', 'extra_staff_seat', 'priority_marketplace_placement',
  'advanced_tax_compliance', 'sms_notifications',
] as const;

/** What a seller can actually buy today. Only add-ons that deliver a real,
 *  working benefit are sellable:
 *  - `advanced_tax_compliance` / `sms_notifications` were charged monthly but
 *    no code anywhere consumed them (zero benefit).
 *  - `priority_marketplace_placement` only set a `featured` badge that no
 *    page renders any more (central marketplace was disconnected).
 *  - `extra_staff_seat` — Shopify doesn't sell staff seats; more staff comes
 *    from a higher plan, so Solvexo follows the same rule.
 *  Existing active purchases of those four are no longer renewed (see
 *  PlatformAddonsService.processRecurringAddonRenewals). */
export const PURCHASABLE_ADDON_TYPES = ['extra_ai_credits'] as const;

export class PurchaseAddonDto {
  @ApiProperty({ enum: PURCHASABLE_ADDON_TYPES })
  @IsIn(PURCHASABLE_ADDON_TYPES, { message: 'This add-on is not available for purchase' })
  addonType: (typeof PURCHASABLE_ADDON_TYPES)[number];

  @ApiProperty({ required: false, default: 1, description: 'Units to purchase (e.g. 2 = 1000 extra AI credits at $10/500)' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  quantity?: number;
}
