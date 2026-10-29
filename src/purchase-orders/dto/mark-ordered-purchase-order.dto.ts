/* eslint-disable prettier/prettier */
import { IsBoolean, IsOptional } from 'class-validator';

export class MarkOrderedPurchaseOrderDto {
  /** Send the PO to the supplier's email in the same action. */
  @IsOptional() @IsBoolean()
  emailSupplier?: boolean;
}
