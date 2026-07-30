/* eslint-disable prettier/prettier */
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MediaLibraryService } from './media-library.service';

@ApiTags('Media Library')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/media-library')
export class MediaLibraryController {
  constructor(private readonly mediaLibraryService: MediaLibraryService) {}

  // Returns the caller's own previously-uploaded promotional creatives — admin
  // sees admin-owned assets, seller sees their own, scoped by role+userId.
  @Get()
  async list(@Req() req: any) {
    const ownerType: 'admin' | 'seller' = req.user.role === 'admin' ? 'admin' : 'seller';
    const assets = await this.mediaLibraryService.listForOwner(ownerType, req.user.userId);
    return { success: true, data: assets };
  }
}
