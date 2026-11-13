import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ContactService } from './contact.service';
import { CreateContactSubmissionDto, UpdateContactStatusDto } from './dto/contact.dto';
import { ReplyContactDto } from './dto/support.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
@ApiTags('Contact')
@Controller('api/contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  // ============================================================
  // PUBLIC (No Auth) — Contact Us form submission
  // ============================================================

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @ApiOperation({ summary: 'Submit the Contact Us form (public)' })
  submit(@Body() dto: CreateContactSubmissionDto) {
    return this.contactService.submit(dto);
  }

  // ============================================================
  // ADMIN (Auth Required)
  // ============================================================

  @RequirePermission('content.manage')
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all contact submissions (admin)' })
  getAll(@Query('tier') tier?: string, @Query('source') source?: string) {
    return this.contactService.findAll({ tier, source });
  }

  @RequirePermission('content.manage')
  @Post('admin/:id/reply')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @ApiOperation({ summary: 'Answer a contact submission by email (admin)' })
  reply(@Req() req: any, @Param('id') id: string, @Body() dto: ReplyContactDto) {
    return this.contactService.reply(id, dto.message, String(req.user?.name ?? req.user?.email ?? 'Solvexo'));
  }

  @RequirePermission('content.manage')
  @Patch('admin/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a contact submission status (admin)' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateContactStatusDto) {
    return this.contactService.updateStatus(id, dto);
  }

  @RequirePermission('content.manage')
  @Delete('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a contact submission (admin)' })
  remove(@Param('id') id: string) {
    return this.contactService.remove(id);
  }
}
