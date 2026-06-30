/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsOptional, IsEnum, IsBoolean,
  IsArray, ValidateNested, IsNumber, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AttachmentItemDto {
  @ApiProperty() @IsString() @IsNotEmpty() url: string;
  @ApiProperty() @IsString() @IsNotEmpty() publicId: string;
  @ApiProperty() @IsString() @IsNotEmpty() resourceType: string;
  @ApiProperty() @IsString() @IsNotEmpty() mimeType: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() fileName?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) fileSize?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() thumbnailUrl?: string;
}

export class ProductShareDto {
  @ApiProperty({ description: 'Product _id — details are fetched automatically' })
  @IsString()
  @IsNotEmpty()
  productId: string;
}

export class ReplyToDto {
  @ApiProperty() @IsString() @IsNotEmpty() messageId: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() text?: string;
  @ApiProperty() @IsString() @IsNotEmpty() type: string;
  @ApiProperty() @IsString() @IsNotEmpty() senderId: string;
  @ApiProperty() @IsString() @IsNotEmpty() senderRole: string;
}

export class ForwardedFromDto {
  @ApiProperty() @IsString() @IsNotEmpty() originalSenderId: string;
  @ApiProperty() @IsString() @IsNotEmpty() originalSenderRole: string;
}

export class SendMessageDto {
  @ApiProperty({ enum: ['text', 'image', 'video', 'pdf', 'document', 'voice', 'product_share'] })
  @IsEnum(['text', 'image', 'video', 'pdf', 'document', 'voice', 'product_share'])
  type: string;

  @ApiProperty({ required: false, example: 'Hello! Is this item available?' })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiProperty({ type: [AttachmentItemDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentItemDto)
  attachments?: AttachmentItemDto[];

  @ApiProperty({ type: ProductShareDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProductShareDto)
  productShare?: ProductShareDto;

  @ApiProperty({ type: ReplyToDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReplyToDto)
  replyTo?: ReplyToDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isForwarded?: boolean;

  @ApiProperty({ type: ForwardedFromDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ForwardedFromDto)
  forwardedFrom?: ForwardedFromDto;
}
