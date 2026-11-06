/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { MessagingConsentService } from './messaging-consent.service';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { MessagingCampaignsService } from './messaging-campaigns.service';

/**
 * Seller: WhatsApp marketing (consent list, templates, campaigns). OFF until the platform owner sets MESSAGING_CAMPAIGNS_ENABLED=true:
 * it talks to Meta's WhatsApp Cloud API, whose field mapping has not been verified against a live account. Permission: marketing.manage.
 */
@ApiTags('Messaging channels (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/messaging/:storeId')
export class MessagingController {
  constructor(
    private readonly consent: MessagingConsentService,
    private readonly templates: WhatsAppTemplatesService,
    private readonly campaigns: MessagingCampaignsService,
    private readonly db: DatabaseService,
  ) {}

  private async own(req: any, storeId: string) {
    if (process.env.MESSAGING_CAMPAIGNS_ENABLED !== 'true') throw new ForbiddenException('Messaging campaigns are not available yet.');
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }

  // consent
  @Get('consents') @RequirePermission('marketing.manage')
  async consents(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.consent.list(s, q); }
  @Post('consents/opt-in') @RequirePermission('marketing.manage')
  async optIn(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); return this.consent.optIn(s, 'whatsapp', b?.phone, { source: 'manual', name: b?.name }); }
  @Post('consents/opt-out') @RequirePermission('marketing.manage')
  async optOut(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); return this.consent.optOut(s, 'whatsapp', b?.phone, 'seller'); }
  @Post('consents/import') @RequirePermission('marketing.manage')
  async importConsents(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); return this.consent.importOptIns(s, 'whatsapp', b?.rows, b?.attested); }

  // templates
  @Get('templates') @RequirePermission('marketing.manage')
  async listTemplates(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.templates.list(s); }
  @Post('templates/sync') @RequirePermission('marketing.manage')
  async sync(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.templates.sync(s); }
  @Post('templates') @RequirePermission('marketing.manage')
  async submit(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); return this.templates.submit(s, b); }
  @Delete('templates/:id') @RequirePermission('marketing.manage')
  async removeTemplate(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.templates.remove(s, id); }

  // campaigns
  @Get('campaigns') @RequirePermission('marketing.manage')
  async listCampaigns(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.campaigns.list(s, q); }
  @Post('campaigns') @RequirePermission('marketing.manage')
  async create(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.campaigns.create(s, await this.own(req, s), b); }
  @Patch('campaigns/:id') @RequirePermission('marketing.manage')
  async update(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.campaigns.update(s, await this.own(req, s), id, b); }
  @Delete('campaigns/:id') @RequirePermission('marketing.manage')
  async remove(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.campaigns.deleteDraft(s, await this.own(req, s), id); }
  @Post('campaigns/:id/launch') @RequirePermission('marketing.manage')
  async launch(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.campaigns.launch(s, await this.own(req, s), id); }
  @Post('campaigns/:id/cancel') @RequirePermission('marketing.manage')
  async cancel(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.campaigns.cancel(s, await this.own(req, s), id); }
  @Get('campaigns/:id/stats') @RequirePermission('marketing.manage')
  async stats(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.campaigns.stats(s, id); }
  @Get('campaigns/:id/messages') @RequirePermission('marketing.manage')
  async log(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Query() q: any) { await this.own(req, s); return this.campaigns.messageLog(s, id, q); }
}
