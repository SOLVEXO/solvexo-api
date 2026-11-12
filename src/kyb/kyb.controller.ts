/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Post, Put, Req, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { KybService } from './kyb.service';
import { kybMaxFileBytes } from './kyb-validators';
import { KYB_DOCUMENT_TYPES } from './kyb.schemas';

export class SaveKybDraftDto {
  @IsOptional() @IsString() businessType?: string | null;
  @IsOptional() @IsString() @MaxLength(160) legalBusinessName?: string | null;
  @IsOptional() @IsString() @MaxLength(300) businessAddress?: string | null;
  @IsOptional() @IsObject() contact?: { name?: string | null; designation?: string | null; email?: string | null; phone?: string | null };
  @IsOptional() @IsString() @MaxLength(100) bankName?: string | null;
  @IsOptional() @IsString() @MaxLength(40) cnic?: string | null;
  @IsOptional() @IsString() @MaxLength(40) ntn?: string | null;
  @IsOptional() @IsString() @MaxLength(40) iban?: string | null;
  @IsOptional() @IsString() @MaxLength(120) accountTitle?: string | null;
}
export class UploadKybDocumentDto { @IsIn([...KYB_DOCUMENT_TYPES]) type: string; }

/** Owner-facing business verification (owner portal / web). Seller JWT only; sensitive values come back masked, never decrypted. */
@ApiTags('Business verification (KYB)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/kyb/:storeId')
export class KybController {
  constructor(private readonly kyb: KybService) {}
  private ctx(req: any) { return { ip: req.ip, userAgent: req.headers?.['user-agent'] }; }

  @Get() get(@Req() req: any, @Param('storeId') storeId: string) { return this.wrap(this.kyb.getOwn(req.user.userId, storeId)); }

  @Put('draft') save(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SaveKybDraftDto) { return this.wrap(this.kyb.saveDraft(req.user.userId, storeId, dto, this.ctx(req))); }

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: kybMaxFileBytes() } }))
  upload(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UploadKybDocumentDto, @UploadedFile() file: Express.Multer.File) {
    return this.wrap(this.kyb.uploadDocument(req.user.userId, storeId, dto.type, file, this.ctx(req)));
  }

  @Delete('documents/:docId') remove(@Req() req: any, @Param('storeId') storeId: string, @Param('docId') docId: string) { return this.wrap(this.kyb.removeDocument(req.user.userId, storeId, docId, this.ctx(req))); }

  @Post('submit') submit(@Req() req: any, @Param('storeId') storeId: string) { return this.wrap(this.kyb.submit(req.user.userId, storeId, this.ctx(req))); }

  private async wrap(p: Promise<any>) { return { success: true, data: await p }; }
}
