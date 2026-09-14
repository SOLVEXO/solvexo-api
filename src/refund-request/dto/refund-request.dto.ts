import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateRefundRequestDto {
  @ApiProperty({ example: '65f1...' })
  @IsString() orderId: string;

  @ApiProperty({ example: '65f1...', description: "The specific SellerOrder subdocument id within this order" })
  @IsString() sellerOrderId: string;

  @ApiProperty({ example: ['65f1...'], description: 'One or more OrderItem subdocument ids within that sellerOrder' })
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) itemIds: string[];

  @ApiProperty({ example: 'Item arrived damaged' })
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class RejectRefundRequestDto {
  @ApiProperty({ example: 'Return window has already closed' })
  @IsString() @MinLength(3) @MaxLength(500) notes: string;
}

export type RestockDecision = 'restock' | 'damaged' | 'skip';

export class ApproveRefundRequestDto {
  // Keyed by OrderItem subdocument id (the same ids the original request's
  // `itemIds` used) — omitted or missing an entry defaults to 'skip', so an
  // existing caller that never sends this body keeps the exact old
  // behavior (payment/ledger only, no stock effect). Every returned
  // physical item genuinely reached the buyer already (RefundRequestService
  // only ever accepts a request once a sellerOrder is delivered/completed —
  // see createRequest's own guard) — the goods physically coming back is
  // what this decides how to handle, never a pre-shipment cancellation
  // (that's a different, already-existing path — see OrdersService).
  @ApiProperty({ required: false, example: { '65f1...': 'restock' } })
  @IsOptional() @IsObject()
  restockDecisions?: Record<string, RestockDecision>;
}
