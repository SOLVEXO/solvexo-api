/* eslint-disable prettier/prettier */
import { Body, Controller, Post, Req, Get, Patch, Query } from '@nestjs/common';
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
import { AuthVisualService } from '../common/auth-visual.service';
import { AUTH_PAGE_CONTEXTS, type AuthPageContext } from '../common/auth-visual-region.const';





@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authVisualService: AuthVisualService,
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
  // actual detected country name (not a bucket of ~15-50 countries), with
  // a 30-day Redis cache per country+screen so the same country/screen
  // pair isn't re-fetched from Unsplash on every visitor. `region` is only
  // still returned for backward compatibility with the earlier curated-map
  // version of this endpoint. Fail-open at every layer (see
  // `AuthVisualService`'s own header comment) — no Unsplash key
  // configured, a network error, a timeout, or an undetectable IP all
  // silently fall back to the curated 10-region map in
  // `auth-visual-region.const.ts`, never an error or a broken image.
  @Get('detect-country')
  async detectCountry(@Req() req: any, @Query('context') context?: string) {
    const country = resolveCountryFromIp(req.ip);
    const ctx = AUTH_PAGE_CONTEXTS.includes(context as AuthPageContext) ? (context as AuthPageContext) : 'register';
    const { region, imageUrl, attribution } = await this.authVisualService.resolve(country, ctx);
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
  async login(@Req() req: any, @Body() loginDto: LoginDto) {
    return this.authService.login(loginDto, req.ip, req.headers['user-agent']);
  }

  // ✅ Social login (Google / Facebook / Apple) — resolves to buyer or seller per dto.role (default 'user')
  @Post('social-login')
  async socialLogin(@Body() socialLoginDto: SocialLoginDto) {
    return this.authService.socialLogin(socialLoginDto);
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
  async verifyOtp(@Body() body: { email: string; role: string, otp: string; storeId?: string }) {
    const { email, role, otp, storeId } = body;
    return this.authService.verifyOtp(email, role, otp, storeId);
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
    return this.authService.logout(token);
  }

  @UseGuards(JwtAuthGuard)
  @Get('getprofile')
  async getProfile(@Req() req: any) {
    const { userId, role } = req.user;
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
  @UseGuards(JwtAuthGuard, RolesGuard)
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