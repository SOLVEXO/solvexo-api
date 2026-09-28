/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminClientsService } from './admin-clients.service';
import { ClientActivityQueryDto } from './dto/client-activity-query.dto';

// A "client" is a `Seller` document — see AdminClientsService's own header
// comment. This controller composes already-`sellerId`-scoped data from
// Users/Analytics/Finance/platform-plans into one workspace per client,
// rather than the admin having to visit five separate pages per seller.
@ApiTags('Admin Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/clients')
export class AdminClientsController {
  constructor(private readonly adminClientsService: AdminClientsService) {}

  @Get(':sellerId/overview')
  getOverview(@Param('sellerId') sellerId: string) {
    return this.adminClientsService.getOverview(sellerId);
  }

  @Get(':sellerId/finance')
  getFinance(@Param('sellerId') sellerId: string) {
    return this.adminClientsService.getFinance(sellerId);
  }

  @Get(':sellerId/moderation')
  getModeration(@Param('sellerId') sellerId: string) {
    return this.adminClientsService.getModeration(sellerId);
  }

  @Get(':sellerId/activity')
  getActivity(@Param('sellerId') sellerId: string, @Query() query: ClientActivityQueryDto) {
    return this.adminClientsService.getActivity(sellerId, query);
  }
}
