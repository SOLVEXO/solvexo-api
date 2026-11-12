/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreContactService } from './store-contact.service';
import { CreateContactMessageDto, ReplyContactMessageDto, UpdateContactMessageDto } from './dto/create-contact-message.dto';

/** Seller inbox for the storefront contact form. Staff with `onlinestore.content.manage` can read and triage it too. */
@ApiTags('Store contact messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-contact')
export class StoreContactController {
  constructor(private readonly service: StoreContactService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string, @Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string, @Query('form') form?: string, @Query('q') q?: string) {
    return this.service.list(storeId, actingSellerId(req.user), { page: Number(page), limit: Number(limit), status, form, q });
  }

  /** The forms that received messages, for the inbox filter. */
  @Get(':storeId/forms')
  forms(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.forms(storeId, actingSellerId(req.user));
  }

  /** CSV of the messages matching the same filters as the list. */
  @Get(':storeId/export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="contact-messages.csv"')
  exportCsv(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string, @Query('form') form?: string, @Query('q') q?: string) {
    return this.service.exportCsv(storeId, actingSellerId(req.user), { status, form, q });
  }

  /** A 2-minute link to one file a visitor attached. */
  @Get(':storeId/:id/file/:fileId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  fileLink(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Param('fileId') fileId: string) {
    return this.service.fileLink(storeId, actingSellerId(req.user), id, fileId);
  }

  /** The CAPTCHA keys of the store's forms (the secret is never sent back). */
  @Get(':storeId/spam-protection')
  spamSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.getSpamSettings(storeId, actingSellerId(req.user));
  }

  @Put(':storeId/spam-protection')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  saveSpamSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { siteKey?: string; secretKey?: string }) {
    return this.service.saveSpamSettings(storeId, actingSellerId(req.user), body);
  }

  @Delete(':storeId/spam-protection')
  clearSpamSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.clearSpamSettings(storeId, actingSellerId(req.user));
  }

  @Patch(':storeId/:id')
  setStatus(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateContactMessageDto) {
    return this.service.setStatus(storeId, actingSellerId(req.user), id, dto.status);
  }

  /** Answers the visitor by email from the store (its own SMTP when connected, else Solvexo's sender with the store's name). */
  @Post(':storeId/:id/reply')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reply(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: ReplyContactMessageDto) {
    return this.service.reply(storeId, actingSellerId(req.user), id, dto.message, String(req.user?.name ?? req.user?.email ?? 'Store'));
  }

  @Delete(':storeId/:id')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.service.remove(storeId, actingSellerId(req.user), id);
  }
}

/** Public (no login): a visitor sends a message to the store. Strictly rate limited. */
@ApiTags('Store contact (public)')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/public/store-contact')
export class PublicStoreContactController {
  constructor(private readonly service: StoreContactService) {}

  /** Which CAPTCHA (if any) the store's forms use: only the public site key. */
  @Get(':storeId/config')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  config(@Param('storeId') storeId: string) {
    return this.service.publicConfig(storeId);
  }

  /** A visitor attaches a file to a form field (private storage; checked against the seller's field). */
  @Post(':storeId/upload')
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  upload(@Param('storeId') storeId: string, @UploadedFile() file: any, @Body() body: { sectionId?: string; fieldId?: string }) {
    return this.service.upload(storeId, body, file);
  }

  @Post(':storeId')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  submit(@Param('storeId') storeId: string, @Body() dto: CreateContactMessageDto, @Req() req: any) {
    return this.service.submit(storeId, dto, req.ip);
  }
}
