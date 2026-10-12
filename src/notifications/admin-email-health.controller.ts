/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EmailHealthService } from './email-health.service';

@ApiTags('Admin email health')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/email-health')
export class AdminEmailHealthController {
  constructor(private readonly health: EmailHealthService) {}

  @Get()
  get() {
    return this.health.getHealth();
  }

  @Post('test')
  test(@Req() req: any) {
    return this.health.sendTest(req.user.userId);
  }
}
