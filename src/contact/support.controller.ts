import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { SupportService } from './support.service';
import { CreateSupportRequestDto } from './dto/support.dto';

/** Help requests from a store dashboard to the Solvexo team. The owner and staff of THAT store can send and read them. */
@ApiTags('Support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('home.view')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@Controller('api/support')
export class SupportController {
  constructor(private readonly service: SupportService) {}

  @Post(':storeId/requests')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a help request to Solvexo (tier is set from the store plan)' })
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateSupportRequestDto) {
    return this.service.create(storeId, req.user, actingSellerId(req.user), dto);
  }

  @Get(':storeId/requests')
  @ApiOperation({ summary: "The store's own help requests with Solvexo's replies" })
  list(@Req() req: any, @Param('storeId') storeId: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.list(storeId, actingSellerId(req.user), { page: Number(page), limit: Number(limit) });
  }
}
