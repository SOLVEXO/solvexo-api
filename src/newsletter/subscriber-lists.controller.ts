/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { SUBSCRIBER_IMPORT_COLUMNS } from './subscriber-bulk-import';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { SubscriberListQuery, SubscriberListsService } from './subscriber-lists.service';

class AddSubscriberDto {
  @IsEmail() email: string;
}

class SetSubscriberStatusDto {
  @IsBoolean() subscribed: boolean;
}

class BroadcastDto {
  @IsString() @IsNotEmpty() @MaxLength(200) subject: string;
  @IsString() @IsNotEmpty() @MaxLength(100_000) message: string;
  @IsOptional() @IsEmail() testEmail?: string;
}

function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

/** A store's own subscriber list — seller (or staff with customer access). */
@ApiTags('Newsletter — store subscribers')
@ApiBearerAuth()
@Controller('api/newsletter/stores/:storeId/subscribers')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
export class StoreSubscribersController {
  constructor(private readonly lists: SubscriberListsService) {}

  @RequirePermission('customers.view')
  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: SubscriberListQuery) {
    await this.lists.assertStoreOwner(storeId, actingSellerId(req.user));
    return this.lists.list(storeId, query);
  }

  @RequirePermission('customers.export')
  @Get('export')
  async export(@Req() req: any, @Param('storeId') storeId: string, @Query() query: SubscriberListQuery, @Res() res: Response) {
    await this.lists.assertStoreOwner(storeId, actingSellerId(req.user));
    sendCsv(res, `subscribers-${new Date().toISOString().slice(0, 10)}.csv`, await this.lists.exportCsv(storeId, query));
  }

  @RequirePermission('customers.edit')
  @Post()
  async add(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AddSubscriberDto) {
    await this.lists.assertStoreOwner(storeId, actingSellerId(req.user));
    return this.lists.addOne(storeId, dto.email, 'seller');
  }

  @RequirePermission('customers.edit')
  @Get('import-template')
  async importTemplate() {
    return buildTemplatePayload('subscribers-import-template.csv', SUBSCRIBER_IMPORT_COLUMNS);
  }

  @RequirePermission('customers.edit')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any, @Body() body: any) {
    await this.lists.assertStoreOwner(storeId, actingSellerId(req.user));
    // The seller attests every imported address agreed to receive marketing
    // email — required, same as Shopify's import checkbox (multipart field).
    if (String(body?.consentConfirmed) !== 'true') {
      throw new BadRequestException('Please confirm these customers agreed to receive marketing emails');
    }
    return this.lists.importCsv(storeId, readUploadedCsv(file), 'import');
  }

  @RequirePermission('customers.edit')
  @Patch(':subscriberId')
  async setStatus(@Req() req: any, @Param('storeId') storeId: string, @Param('subscriberId') id: string, @Body() dto: SetSubscriberStatusDto) {
    await this.lists.assertStoreOwner(storeId, actingSellerId(req.user));
    return this.lists.setStatus(storeId, id, dto.subscribed);
  }

  @RequirePermission('customers.edit')
  @Delete(':subscriberId')
  async remove(@Req() req: any, @Param('storeId') storeId: string, @Param('subscriberId') id: string) {
    await this.lists.assertStoreOwner(storeId, actingSellerId(req.user));
    return this.lists.remove(storeId, id);
  }
}

/** Solvexo's own platform list (people who signed up on Solvexo's public
 *  site) and the admin's broadcast to it. */
@ApiTags('Newsletter — admin')
@ApiBearerAuth()
@Controller('api/admin/newsletter')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminNewsletterController {
  constructor(private readonly lists: SubscriberListsService) {}

  @Get('subscribers')
  list(@Query() query: SubscriberListQuery) {
    return this.lists.list(null, query);
  }

  @Get('subscribers/export')
  async export(@Query() query: SubscriberListQuery, @Res() res: Response) {
    sendCsv(res, `solvexo-subscribers-${new Date().toISOString().slice(0, 10)}.csv`, await this.lists.exportCsv(null, query));
  }

  @Patch('subscribers/:subscriberId')
  setStatus(@Param('subscriberId') id: string, @Body() dto: SetSubscriberStatusDto) {
    return this.lists.setStatus(null, id, dto.subscribed);
  }

  @Delete('subscribers/:subscriberId')
  remove(@Param('subscriberId') id: string) {
    return this.lists.remove(null, id);
  }

  @Get('broadcasts')
  broadcasts() {
    return this.lists.listBroadcasts();
  }

  @Post('broadcasts')
  broadcast(@Req() req: any, @Body() dto: BroadcastDto) {
    return this.lists.broadcast(req.user.userId, dto.subject, dto.message, dto.testEmail);
  }
}
