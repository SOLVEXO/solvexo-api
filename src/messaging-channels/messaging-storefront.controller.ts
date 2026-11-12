/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Model } from 'mongoose';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { DatabaseService } from '../database/databaseservice';
import { MessagingConsent, MessagingConsentDocument } from './messaging.schema';
import { MessagingConsentService } from './messaging-consent.service';
import { SmsGatewayService } from './sms-gateway.service';
import { Channel, CHANNELS } from './messaging-rules.util';

const enabled = () => process.env.MESSAGING_CAMPAIGNS_ENABLED === 'true';

/**
 * Storefront (signed-in customer): the customer's OWN messaging consent for this store. An opt-in is an explicit action (a box ticked with a
 * typed phone number). Honest limit: the number is not yet confirmed with a code, so a store should treat "storefront" opt-ins accordingly.
 */
@ApiTags('Messaging preferences (storefront)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/messaging/storefront')
export class MessagingStorefrontController {
  constructor(
    private readonly consent: MessagingConsentService,
    private readonly sms: SmsGatewayService,
    private readonly db: DatabaseService,
    @InjectModel(MessagingConsent.name) private readonly consents: Model<MessagingConsentDocument>,
  ) {}

  /** Which channels this store really offers (feature on + WhatsApp connected / SMS gateway tested and on). */
  private async available(storeId: string) {
    if (!enabled()) return { whatsapp: false, sms: false };
    const [wa, sms] = await Promise.all([
      this.db.repositories.storeIntegrationModel.exists({ storeId, type: 'whatsapp', provider: 'whatsapp_cloud', status: 'connected' }),
      this.sms.activeConfig(storeId),
    ]);
    return { whatsapp: !!wa, sms: !!sms };
  }

  private async realCustomer(storeId: string, userId: string) {
    const u: any = await (this.db.repositories as any).userModel.findOne({ _id: userId, storeId }).select('isGuest').lean();
    if (!u || u.isGuest) throw new ForbiddenException('Sign in with a customer account.');
  }

  @Get('me')
  async me(@Req() req: any, @Query('storeId') storeId?: string) {
    const s = resolveBuyerStoreScope(req.user.storeId, storeId);
    const rows: any[] = await this.consents.find({ storeId: s, customerId: String(req.user.userId) }).select('channel status contactKey optedInAt optedOutAt').lean();
    return {
      available: await this.available(s),
      consents: rows.map((r) => ({ channel: r.channel, status: r.status, phoneEnding: String(r.contactKey).slice(-4), optedInAt: r.optedInAt, optedOutAt: r.optedOutAt })),
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('opt-in')
  async optIn(@Req() req: any, @Body() body: any) {
    const s = resolveBuyerStoreScope(req.user.storeId, body?.storeId);
    const channel: Channel = body?.channel;
    if (!(CHANNELS as readonly string[]).includes(channel)) throw new BadRequestException('Unknown channel');
    if (body?.agreed !== true) throw new BadRequestException('Tick the box to agree to receive these messages');
    await this.realCustomer(s, String(req.user.userId));
    if (!(await this.available(s))[channel]) throw new BadRequestException('This store does not send messages on this channel yet.');
    await this.consent.optIn(s, channel, body?.phone, { source: 'storefront', customerId: String(req.user.userId) });
    return this.me(req, s);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('opt-out')
  async optOut(@Req() req: any, @Body() body: any) {
    const s = resolveBuyerStoreScope(req.user.storeId, body?.storeId);
    const channel: Channel = body?.channel;
    if (!(CHANNELS as readonly string[]).includes(channel)) throw new BadRequestException('Unknown channel');
    // Withdraw every number this customer opted in with on this channel: an opt-out never needs the number typed again.
    const rows: any[] = await this.consents.find({ storeId: s, channel, customerId: String(req.user.userId), status: 'opted_in' }).select('contactKey').lean();
    for (const r of rows) await this.consent.optOut(s, channel, r.contactKey, 'storefront');
    return this.me(req, s);
  }
}
