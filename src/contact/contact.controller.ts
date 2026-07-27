import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ContactService } from './contact.service';
import { CreateContactSubmissionDto, UpdateContactStatusDto } from './dto/contact.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

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

  @Get('admin/all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all contact submissions (admin)' })
  getAll() {
    return this.contactService.findAll();
  }

  @Patch('admin/:id/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a contact submission status (admin)' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateContactStatusDto) {
    return this.contactService.updateStatus(id, dto);
  }

  @Delete('admin/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a contact submission (admin)' })
  remove(@Param('id') id: string) {
    return this.contactService.remove(id);
  }
}
