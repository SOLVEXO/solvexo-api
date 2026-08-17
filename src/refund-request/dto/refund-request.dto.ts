import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';

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
