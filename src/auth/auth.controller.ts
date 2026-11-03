/* eslint-disable prettier/prettier */
import { Body, Controller, Post, Req, Res, Get, Patch, Delete, Query, ForbiddenException, HttpCode, UnauthorizedException } from '@nestjs/common';
import { REFRESH_COOKIE, assertCsrf, assertPortalOrigin, clearRefreshCookie, isCookieMode, issueCsrf, setRefreshCookie } from './portal-cookie.util';
import { GuestSessionService } from './guest-session.service';
import { GuestSessionDto, GuestContactDto } from './dto/guest-session.dto';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard'; ;
import { resolveCountryFromIp } from '../common/geo-locate.util';
import { resolveCountryName } from '../common/country-names.const';
import { AuthVisualService } from '../common/auth-visual.service';
import { AUTH_PAGE_CONTEXTS, AUTH_VISUAL_TOPICS, type AuthPageContext, type AuthVisualTopic } from '../common/auth-visual-region.const';





import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authVisualService: AuthVisualService,
    private readonly guestSessions: GuestSessionService,
  ) {}

  // Real IP-based country detection — powers two independent frontend
  // features off one lookup: (1) the Register form's phone input auto-
  // selects the right dial code/flag instead of defaulting everyone to the
  // same country; (2) `region`/`imageUrl` let AuthSplitLayout (shared by
  // every auth screen — Register/Login/Onboarding/etc.) show a real,
  // LIVE, country-specific background photo instead of one fixed generic
  // illustration for every visitor worldwide. The optional `?context=`
  // query param (`register`|`login`|`onboarding`|`forgot_password`|`otp`|
  // `new_password`) is folded into the search query — so the same visitor
  // sees a different (but same-country) photo depending on which auth
  // screen they're on; an invalid or missing context safely falls back to
  // `'register'`. `imageUrl` is resolved by `AuthVisualService` — a real,
  // per-request Unsplash Random Photo API lookup keyed off the visitor's
  // actual detected country name, fetched live on every request (no cache),
  // steered by the screen/onboarding step (`context`) and, on the last
  // onboarding step, the chosen seller type (`topic`), with culturally
  // unsuitable photos filtered out. `region` is only
  // still returned for backward compatibility with the earlier curated-map
  // version of this endpoint. Fail-open at every layer (see
  // `AuthVisualService`'s own header comment) — no Unsplash key
  // configured, a network error, a timeout, or an undetectable IP all
  // silently fall back to the curated 10-region map in
  // `auth-visual-region.const.ts`, never an error or a broken image.
  @Get('detect-country')
  async detectCountry(@Req() req: any, @Query('context') context?: string, @Query('topic') topic?: string, @Query('country') urlCountry?: string) {
    // A country chosen in the page URL (`/pk/register`) wins over the IP guess, but only a real country code counts.
    const fromUrl = typeof urlCountry === 'string' && /^[A-Za-z]{2}$/.test(urlCountry) && resolveCountryName(urlCountry.toUpperCase()) ? urlCountry.toUpperCase() : null;
    const country = fromUrl ?? resolveCountryFromIp(req.ip);
    const ctx = AUTH_PAGE_CONTEXTS.includes(context as AuthPageContext) ? (context as AuthPageContext) : 'register';
    const safeTopic = AUTH_VISUAL_TOPICS.includes(topic as AuthVisualTopic) ? (topic as AuthVisualTopic) : undefined;
    const { region, imageUrl, attribution } = await this.authVisualService.resolve(country, ctx, safeTopic);
    return { success: true, data: { country, region, imageUrl, attribution } };
  }

  // ✅ Signup
  // Rate-limited (per IP) same as every other public account-creation-shaped
  // endpoint in this codebase (contact/newsletter) — previously relied only
  // on the 100/min global default, which does nothing against a scripted
  // burst of registration/OTP attempts.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async signup( @Body() RegisterDto: RegisterDto) {
    return this.authService.signup(RegisterDto);
  }

  // ✅ Login — tighter than the 100/min global default specifically to slow
  // down password-guessing against one account from one IP.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  async login(@Req() req: any, @Res({ passthrough: true }) res: any, @Body() loginDto: LoginDto) {
    const cookie = isCookieMode(req);
    if (cookie) assertCsrf(req);
    const result = await this.authService.login(loginDto, req.ip, req.headers['user-agent']);
    if (loginDto.role === 'user') await this.guestSessions.mergeFromAuthResult(result, loginDto.storeId);
    return cookie ? this.finishCookieSession(req, res, result) : result;
  }

  /** Portal (cookie mode): the refresh token goes into the HttpOnly cookie, never the body; a rotated CSRF token comes back in the body. */
  private async finishCookieSession(req: any, res: any, result: any) {
    const { body, refreshToken } = await this.authService.toCookieSession(result);
    setRefreshCookie(req, res, refreshToken);
    return { ...body, data: { ...body.data, csrfToken: issueCsrf(req, res) } };
  }

  /** Step 1 of every cookie-mode flow: sets the signed double-submit cookie and returns its token. Only PORTAL_ORIGINS may call it. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('csrf')
  csrf(@Req() req: any, @Res({ passthrough: true }) res: any) {
    assertPortalOrigin(req);
    res.setHeader('Cache-Control', 'no-store');
    return { success: true, data: { csrfToken: issueCsrf(req, res) } };
  }

  // Shopify-style guest checkout: starts a password-less buyer session for this store (no account needed), unless the
  // store's "Customer accounts" setting is 'required'. Throttled per IP — it creates a row.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('guest')
  async startGuestSession(@Body() dto: GuestSessionDto) {
    return this.guestSessions.createSession(dto.storeId);
  }

  // The email a guest checks out with (confirmation emails + attaching orders to a later account).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Patch('guest/contact')
  async setGuestContact(@Req() req: any, @Body() dto: GuestContactDto) {
    if (!req.user.isGuest) throw new ForbiddenException('Only a guest checkout session can do this');
    return this.guestSessions.setContact(req.user.userId, dto);
  }

  // ✅ Social login (Google / Facebook / Apple) — resolves to buyer or seller per dto.role (default 'user')
  @Post('social-login')
  async socialLogin(@Req() req: any, @Res({ passthrough: true }) res: any, @Body() socialLoginDto: SocialLoginDto) {
    const cookie = isCookieMode(req);
    if (cookie) assertCsrf(req);
    const result = await this.authService.socialLogin(socialLoginDto);
    if ((socialLoginDto.role ?? 'user') === 'user') await this.guestSessions.mergeFromAuthResult(result, socialLoginDto.storeId);
    return cookie ? this.finishCookieSession(req, res, result) : result;
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: any, @Res({ passthrough: true }) res: any, @Body() body: { refreshToken?: string }) {
    if (isCookieMode(req)) {
      assertCsrf(req);
      const token = req.cookies?.[REFRESH_COOKIE];
      if (!token || typeof token !== 'string') throw new UnauthorizedException('Not signed in');
      try {
        const { body: out, refreshToken } = await this.authService.refreshCookie(token);
        setRefreshCookie(req, res, refreshToken);
        return { ...out, data: { ...out.data, csrfToken: issueCsrf(req, res) } };
      } catch (e: any) {
        // A retryable race must keep the (possibly just-rotated) cookie; every other failure ends the browser session.
        if (e?.getResponse?.()?.code !== 'REFRESH_IN_PROGRESS') clearRefreshCookie(req, res);
        throw e;
      }
    }
    if (!body?.refreshToken || typeof body.refreshToken !== 'string') throw new UnauthorizedException('Invalid refresh token');
    return this.authService.refresh(body.refreshToken);
  }

  /** Cookie-mode sign-out: revokes the refresh family and clears the cookie. Same CSRF rules as the other cookie endpoints. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Delete('refresh')
  async signOutCookie(@Req() req: any, @Res({ passthrough: true }) res: any) {
    assertCsrf(req);
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token && typeof token === 'string') await this.authService.revokeFamilyFromToken(token);
    clearRefreshCookie(req, res);
    return { success: true, message: 'Signed out', data: null };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('resend-otp')
  async resendOtp(@Body() body: { email: string; role: string; storeId?: string }) {
    const { email, role, storeId } = body;
    return this.authService.resendOtp(email, role, storeId);
  }

  // A 6-digit OTP is only 1,000,000 combinations — without a tight per-IP
  // limit here, that's brute-forceable well within the OTP's expiry window.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verifyOtp')
  async verifyOtp(@Req() req: any, @Res({ passthrough: true }) res: any, @Body() body: { email: string; role: string, otp: string; storeId?: string }) {
    const { email, role, otp, storeId } = body;
    const cookie = isCookieMode(req);
    if (cookie) assertCsrf(req);
    const result = await this.authService.verifyOtp(email, role, otp, storeId);
    if (role === 'user') await this.guestSessions.mergeFromAuthResult(result, storeId);
    return cookie ? this.finishCookieSession(req, res, result) : result;
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  async forgotPassword(
    @Body('email') email: string,
    @Body('role') role: string,
    @Body('storeId') storeId?: string,
  ) {
    return this.authService.forgotPassword(email, role, storeId);
  }

  // Same OTP-brute-force reasoning as verifyOtp above — reset-password also
  // takes a raw `otp` guess.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  async resetPassword(
  @Body('email') email: string,
  @Body('role') role: string,
  @Body('otp') otp: string,
  @Body('newPassword') newPassword: string,
  @Body('storeId') storeId?: string,
) {
  return this.authService.resetPassword(email, role, otp, newPassword, storeId);
}

  // Lets the forgot-password OTP screen reject a wrong/expired code right
  // there, instead of only finding out on the next screen when reset-
  // password is called with a new password already typed in. Read-only —
  // never marks the code used, so the follow-up reset-password call still
  // needs (and validates) the same otp itself. Same brute-force reasoning
  // as verifyOtp/reset-password above.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-reset-otp')
  async verifyResetOtp(
    @Body('email') email: string,
    @Body('role') role: string,
    @Body('otp') otp: string,
    @Body('storeId') storeId?: string,
  ) {
    return this.authService.verifyResetOtp(email, role, otp, storeId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Req() req: any) {
    const token = req.headers.authorization?.split(' ')[1];
    return this.authService.logout(token, req.cookies?.[REFRESH_COOKIE]);
  }

  @UseGuards(JwtAuthGuard)
  @Get('getprofile')
  async getProfile(@Req() req: any) {
    const { userId, role } = req.user;
    if (req.user.viewAs) return this.authService.getViewAsProfile(req.user);
    return this.authService.getProfile(userId, role);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('edit-profile')
  async editProfile(@Req() req: any, @Body() updateProfileDto: UpdateProfileDto) {
    const { userId, role } = req.user;
    return this.authService.editProfile(userId, role, updateProfileDto);
  }

  // The only way a new admin account can be created — public registration
  // no longer allows role:'admin' (see RegisterDto). Only an already
  // logged-in admin can call this, so admin access can only ever be
  // extended by an existing admin, never granted to oneself.
  @RequirePermission('team.manage')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @Post('admin/create-admin')
  async createAdmin(@Req() req: any, @Body() dto: CreateAdminDto) {
    return this.authService.createAdmin(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

}