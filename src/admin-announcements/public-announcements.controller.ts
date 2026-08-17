/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminAnnouncementsService } from './admin-announcements.service';

// Public — no auth guard. Buyers (logged out or logged in) and sellers both
// need to see platform announcements; only admin CRUD requires @Roles('admin').
@ApiTags('Announcements (public)')
@Controller('api/announcements')
export class PublicAnnouncementsController {
  constructor(private readonly adminAnnouncementsService: AdminAnnouncementsService) {}

  @Get('active')
  getActive(@Query('audience') audience?: string) {
    if (audience !== 'buyers' && audience !== 'sellers') {
      throw new BadRequestException('audience must be "buyers" or "sellers"');
    }
    return this.adminAnnouncementsService.getActiveForAudience(audience);
  }
}
