import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OptionalJwtAuthGuard } from '@/auth/guards/optional-jwt-auth.guard';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { resolveBuyerStoreScope } from '@/common/store-scope.util';
import { NewsletterService } from './newsletter.service';
import {
  SubscribeMeDto,
  SubscribeNewsletterDto,
} from './dto/subscribe-newsletter.dto';

// Public — anyone (logged in or not) can subscribe, from Solvexo's own site
// (no storeId) or from any store's storefront (storeId = that store's list).
// A logged-in buyer's token is only used to link the row to their account.
@ApiTags('Newsletter (public)')
@Controller('api/newsletter')
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(OptionalJwtAuthGuard)
  @Post('subscribe')
  subscribe(@Req() req: any, @Body() dto: SubscribeNewsletterDto) {
    const userId = req.user?.role === 'user' ? req.user.userId : null;
    return this.newsletterService.subscribe(dto.email, {
      storeId: dto.storeId ?? null,
      source: dto.source,
      userId,
    });
  }

  /** A logged-in buyer opting in to one store's emails — the checkout
   *  "Email me with news and offers" checkbox. The address is always the
   *  account's own (read server-side), never a client-sent one, and the
   *  store is scoped the same way checkout itself is. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('subscribe-me')
  subscribeMe(@Req() req: any, @Body() dto: SubscribeMeDto) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, dto.storeId);
    return this.newsletterService.subscribeAccount(
      req.user.userId,
      storeId,
      'checkout',
    );
  }

  /** Link in a double opt-in confirmation email. */
  @Get('confirm/:token')
  @Header('Content-Type', 'text/html')
  confirm(@Param('token') token: string) {
    return this.newsletterService.confirmByToken(token);
  }

  @Get('unsubscribe/:token')
  @Header('Content-Type', 'text/html')
  unsubscribe(@Param('token') token: string) {
    return this.newsletterService.unsubscribeByToken(token);
  }

  /** RFC 8058 one-click unsubscribe — what Gmail/Yahoo's "Unsubscribe"
   *  button POSTs to via the List-Unsubscribe-Post header on every
   *  marketing email. */
  @Post('unsubscribe/:token')
  @HttpCode(200)
  async unsubscribeOneClick(@Param('token') token: string) {
    await this.newsletterService.unsubscribeByToken(token);
    return { success: true };
  }
}
