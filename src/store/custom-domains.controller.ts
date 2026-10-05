/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { CustomDomainsService } from './custom-domains.service';

class DomainDto { @IsString() @MaxLength(253) domain: string; }
class PrimaryDomainDto { @IsOptional() @IsString() @MaxLength(253) domain?: string | null; }

const actor = (req: any) => ({ actorId: String(req.user.userId), actorRole: (req.user.role === 'staff' ? 'staff' : 'seller') as 'seller' | 'staff' });

/** Shopify Settings → Domains. Every route carries `:storeId`, so PermissionsGuard pins a staff caller to their own store. */
@ApiTags('Store domains')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.domains.manage')
@Controller('api/store/:storeId/domains')
export class CustomDomainsController {
  constructor(private readonly domains: CustomDomainsService) {}

  @Get()
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.domains.list(actingSellerId(req.user), storeId);
  }

  @Post()
  add(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: DomainDto) {
    return this.domains.add(actingSellerId(req.user), storeId, dto.domain, actor(req));
  }

  // Declared before ':domain/...' so "primary" is never read as a domain name.
  @Post('primary')
  setPrimary(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PrimaryDomainDto) {
    return this.domains.setPrimary(actingSellerId(req.user), storeId, dto.domain ?? null, actor(req));
  }

  @Post(':domain/verify')
  verify(@Req() req: any, @Param('storeId') storeId: string, @Param('domain') domain: string) {
    return this.domains.verify(actingSellerId(req.user), storeId, domain, actor(req));
  }

  @Delete(':domain')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('domain') domain: string) {
    return this.domains.remove(actingSellerId(req.user), storeId, domain, actor(req));
  }
}
