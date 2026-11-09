import { AdminSecurityService } from './admin-security.service';
import { AdminTwoFactorService } from './admin-two-factor.service';
import { MemberTwoFactorService } from './member-two-factor.service';
import { buildStaffProfile } from '../common/staff-profile.util';
import {
  Injectable,
  Optional,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { OtpService } from '@/otp/otp.service';
import { DatabaseService } from '@/database/databaseservice';
import { OAuth2Client } from 'google-auth-library';
import * as appleSignin from 'apple-signin-auth';
// import axios from 'axios';
import { stat } from 'fs';
import { RedisService } from '../redis/redis.service';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { generateOtp, assertOtpAttempt } from '@/common/otp.util';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { randomUUID } from 'crypto';
import { AppleTokenService } from './apple-token.service';
import { hashJti } from './portal-cookie.util';

@Injectable()
export class AuthService {
  private googleClient = new OAuth2Client(); // verifies Google ID tokens; audiences come from GOOGLE_CLIENT_ID
  constructor(
    private databaseService: DatabaseService,
    private readonly otpService: OtpService,
    private readonly redisService: RedisService,
    private readonly activityLogService: ActivityLogService,

    private readonly jwtService: JwtService,
    // Global module; optional so auth still boots if the notifications module is ever absent.
    @Optional() private readonly notificationsService?: NotificationsService,
    // Appended last (optional) so existing positional construction in specs keeps working.
    @Optional() private readonly adminSecurity?: AdminSecurityService,
    @Optional() private readonly adminTwoFactor?: AdminTwoFactorService,
    // Sign in with Apple token lifecycle (5G.1) — optional so specs that build AuthService positionally keep working.
    @Optional() private readonly appleTokens?: AppleTokenService,
    @Optional() private readonly memberTwoFactor?: MemberTwoFactorService,
  ) {}

  /** Tells the platform admins a new seller joined (in-app + email per their preferences). Never throws. */
  private notifyAdminsNewSeller(name: string | undefined, email: string) {
    this.notificationsService?.notifyAdmins({
      type: NOTIFICATION_TYPES.ADMIN_NEW_SELLER,
      title: 'New seller signed up',
      body: `${name || email} (${email}) just created a seller account.`,
      data: { link: '/admin/clients' },
    }).catch(() => {});
  }

  /** Only the buyer (`User`) collection has a `storeId` dimension — Seller/
   *  Admin accounts are never store-scoped. Building the same `{email}` (or
   *  `{email, storeId}`) filter in one place instead of repeating this
   *  ternary in every method below is what actually makes the same email
   *  resolve to a genuinely separate account per store (see
   *  `User.storeId`'s schema comment) — every buyer lookup in this service
   *  must go through this, not a bare `{email}`. */
  private emailScope(email: string, role: string, storeId?: string | null): Record<string, unknown> {
    // Neither the User nor Seller schema normalizes `email` (no `lowercase`/
    // `trim` schema option, and Mongoose doesn't apply those to query filters
    // even where it does), and no signup/login path lowercased it either —
    // so "Jane@Example.com" at signup vs "jane@example.com" typed at login
    // (or a resend/forgot-password/verify-otp call) missed every one of
    // these lookups and surfaced as a plain "Invalid email or password" /
    // "User not found", indistinguishable from a genuine typo. Normalizing
    // here fixes every caller at once, since every email-based account
    // lookup in this service goes through emailScope.
    // Several auth routes take `email`/`storeId` as untyped body fields (no
    // DTO), so a client could send an object like {"$ne":null} that would be
    // spliced straight into the Mongo filter below (NoSQL operator injection,
    // e.g. matching "any store"). Both must be plain strings.
    if (typeof email !== 'string') {
      throw new BadRequestException('A valid email is required');
    }
    if (storeId !== undefined && storeId !== null && typeof storeId !== 'string') {
      throw new BadRequestException('Invalid storeId');
    }
    const normalizedEmail = email.trim().toLowerCase();
    return role === 'user' ? { email: normalizedEmail, storeId: storeId ?? null } : { email: normalizedEmail };
  }

  /** OTP mail: a store's buyer gets it under that store's name (reply-to = store contact email);
   *  sellers/admins get the platform's own sender. */
  private async sendOtpMail(email: string, otp: string, role: string, storeId?: string | null): Promise<void> {
    // Apple sign-ins that shared no email carry a `.invalid` placeholder: there is nowhere to send a code.
    if (/\.invalid$/i.test(email)) {
      throw new BadRequestException('This account has no deliverable email address. Sign in with Apple instead.');
    }
    let sender: { fromName?: string | null; replyTo?: string | null } | undefined;
    if (role === 'user' && storeId) {
      const store: any = await this.databaseService.repositories.storeModel
        .findById(storeId)
        .select('name contactEmail')
        .lean()
        .catch(() => null);
      if (store) sender = { fromName: store.name ?? null, replyTo: store.contactEmail ?? null };
    }
    await this.otpService.sendOtp(email, otp, sender);
  }

  /** A buyer's storeId is a partition key baked into the account (and later
   *  the JWT) for its whole lifetime — validate it against a real, active
   *  Store up front so a typo'd/forged storeId can't silently create (or be
   *  matched against) an account scoped to a store that doesn't exist. Only
   *  called where a *new* account would be created; an existing account's
   *  storeId was already validated when it was created. */
  private async assertValidStoreId(storeId?: string | null): Promise<void> {
    if (!storeId) return;
    const store = await this.databaseService.repositories.storeModel
      .findOne({ _id: storeId, isDelete: false })
      .select('_id')
      .lean();
    if (!store) {
      throw new UnauthorizedException('Invalid storeId');
    }
  }

  /** Deletes the Redis session key for this access token so `JwtAuthGuard` rejects it immediately, instead of waiting out its TTL. */
  async logout(token: string, refreshCookieToken?: string) {
    await this.redisService.del(token);
    if (refreshCookieToken) await this.revokeFamilyFromToken(refreshCookieToken);
    return {
      success: true,
      message: 'Logged out successfully',
      data: null,
    };
  }

  /** Seller logins/edits are logged against their store's activity feed; users/admins have no store to attach to. */
  private async logSellerSecurityEvent(
    sellerId: string,
    category: 'security' | 'customers',
    action: string,
    description: string,
    ip?: string,
    userAgent?: string,
    isSecurityAlert = false,
  ) {
    try {
      const store = await this.databaseService.repositories.storeModel.findOne({
        sellerId,
        isDelete: false,
      });
      if (!store) return;
      await this.activityLogService.log({
        storeId: String(store._id),
        category,
        action,
        description,
        actorId: sellerId,
        actorRole: 'seller',
        ip,
        userAgent,
        isSecurityAlert,
      });
    } catch {
      // logging must never break auth
    }
  }

  async signup(RegisterDto: RegisterDto) {
    try {
      const {
        name, password, phone, address, role, profileImage, storeId,
        acquisitionSource, acquisitionMedium, acquisitionCampaign, acquisitionLandingPage, partnerCode,
      } = RegisterDto;
      // Stored normalized so this account is actually reachable by every
      // later lookup — every one of them (login, resend-otp, verify-otp,
      // forgot/reset-password) goes through emailScope(), which now
      // normalizes the same way. Storing the raw, as-typed casing here would
      // just move the same mismatch from "lookup" to "the one row it can
      // never match."
      const email = RegisterDto.email?.trim().toLowerCase();

      // Public registration only ever creates a buyer or seller account —
      // RegisterDto.role is already restricted to 'user'|'seller' at the
      // validation layer, and there is deliberately no 'admin' branch here.
      // Admin accounts are created only via the protected
      // POST /api/auth/admin/create-admin endpoint (see createAdmin() below).
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const existingUser = await userModel.findOne(this.emailScope(email, role, storeId));
      if (existingUser) {
        throw new UnauthorizedException('User already exists');
      }

      if (role === 'user') {
        await this.assertValidStoreId(storeId);
      }

      const otp = generateOtp();
      const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = new userModel({
        name,
        email,
        password: hashedPassword,
        phone,
        address,
        profileImage,
        role,
        otp,
        otpExpiresAt,
        isVerified: false,
        // Only the buyer collection has this field — Seller has none, so
        // this is simply dropped for a seller signup (Mongoose ignores
        // fields not declared on the schema).
        ...(role === 'user' ? { storeId: storeId ?? null } : {}),
        // Phase 9 — Merchant Acquisition Tracking. Captured ONCE, here, at
        // the moment a seller account is created — never written again
        // after this (see Seller.acquisitionSource and friends). Buyer
        // (`role === 'user'`) accounts have none of these fields on their
        // schema, so this is simply dropped for a buyer signup, same as
        // storeId above. acquisitionCapturedAt is only set when at least
        // one real value came through — a signup with no UTM params/
        // referrer (organic/direct) correctly leaves every field null
        // rather than stamping a capture time for data that doesn't exist.
        ...(role === 'seller'
          ? {
              acquisitionSource: acquisitionSource ?? null,
              acquisitionMedium: acquisitionMedium ?? null,
              acquisitionCampaign: acquisitionCampaign ?? null,
              acquisitionLandingPage: acquisitionLandingPage ?? null,
              acquisitionPartnerCode: partnerCode?.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40) || null,
              acquisitionCapturedAt:
                acquisitionSource || acquisitionMedium || acquisitionCampaign
                  ? new Date()
                  : null,
            }
          : {}),
      });

      await user.save();

      await this.sendOtpMail(email, otp, role, storeId);

      return {
        message: 'OTP sent successfully',
        success: true,
        data: {
          userId: user._id,
        },
      };
    } catch (error) {
      throw new UnauthorizedException(error.message || 'Signup failed');
    }
  }

  async login(loginDto: LoginDto, ip?: string, userAgent?: string) {
    try {
      const { email, password, role, storeId } = loginDto;

      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const existingUser = await userModel.findOne(this.emailScope(email, role, storeId));
      if (!existingUser) {
        throw new UnauthorizedException('Invalid email or password');
      }
      // Admin accounts: lockout + pending-invite checks before anything about the password is revealed.
      if (role === 'admin') this.adminSecurity?.assertCanAttempt(existingUser);

      // Checked BEFORE the password compare — otherwise whether a wrong
      // password gets 'Invalid email or password' vs an unverified account
      // getting 'Account not verified' becomes a password oracle: an
      // attacker who's guessed the right password for an unverified account
      // would see the message change, confirming the guess without ever
      // completing a real login. Checking this first means an unverified
      // account always gets the same response regardless of the password
      // tried.
      if (!existingUser.isVerified) {
        throw new UnauthorizedException(
          'Account not verified. Please verify OTP first',
        );
      }

      const isPasswordMatch = await bcrypt.compare(
        password,
        existingUser.password,
      );
      if (!isPasswordMatch) {
        if (role === 'admin') await this.adminSecurity?.recordFailure(existingUser);
        if (role === 'seller') {
          this.logSellerSecurityEvent(
            existingUser._id.toString(),
            'security',
            'login_failed',
            `Failed login attempt from ${ip ?? 'unknown IP'}`,
            ip,
            userAgent,
            true,
          );
        }
        throw new UnauthorizedException('Invalid email or password');
      }

      // Applies uniformly to all three roles: User/Seller/Admin schemas all
      // share the same isDelete/status fields (see usersService.deleteAccount /
      // AdminUsersService.suspend) — a deleted or suspended account must not
      // be able to get a fresh session just by logging back in.
      if (existingUser.isDelete || existingUser.status === 'deleted') {
        throw new UnauthorizedException('This account has been deleted');
      }

      if (existingUser.status === 'suspended') {
        throw new UnauthorizedException(
          'This account has been suspended. Please contact support.',
        );
      }

      // Admins with two-factor on get a short-lived challenge instead of a session; completeAdminTwoFactorLogin finishes it.
      if (role === 'admin' && existingUser.twoFactorEnabled && this.adminTwoFactor) {
        return {
          message: 'Enter the code from your authenticator app',
          success: true,
          data: { twoFactorRequired: true, challengeToken: this.adminTwoFactor.signChallenge(existingUser) },
        };
      }

      // Sellers with two-factor on also get a challenge first (completeSellerTwoFactorLogin finishes it).
      if (role === 'seller' && this.memberTwoFactor && (await this.memberTwoFactor.isEnabled('seller', String(existingUser._id)))) {
        return {
          message: 'Enter the code from your authenticator app',
          success: true,
          data: { twoFactorRequired: true, challengeToken: this.memberTwoFactor.signChallenge('seller', String(existingUser._id), { tokenVersion: existingUser.tokenVersion ?? 0 }) },
        };
      }

      if (role === 'seller') {
        this.logSellerSecurityEvent(
          existingUser._id.toString(),
          'security',
          'login_success',
          `Login from ${ip ?? 'unknown IP'}`,
          ip,
          userAgent,
          false,
        );
      }

      return await this.issueLoginSession(existingUser, role, ip, userAgent);
    } catch (error) {
      throw new UnauthorizedException(error.message || 'Login failed');
    }
  }

  /** Second login step for an admin with two-factor on: the challenge from login() plus an authenticator or recovery code. */
  async completeAdminTwoFactorLogin(challengeToken: string, code: string, ip?: string, userAgent?: string) {
    if (!this.adminTwoFactor || !this.adminSecurity) throw new UnauthorizedException('Two-factor sign-in is unavailable');
    const { adminId, tokenVersion } = this.adminTwoFactor.verifyChallenge(challengeToken);
    const admin: any = await this.databaseService.repositories.adminModel.findById(adminId);
    // A password reset, suspension or "sign out everywhere" since the password step voids the challenge.
    if (!admin || admin.isDelete || admin.status !== 'active' || (admin.tokenVersion ?? 0) !== tokenVersion) {
      throw new UnauthorizedException('Your sign-in step expired. Enter your email and password again.');
    }
    this.adminSecurity.assertCanAttempt(admin);
    const result = await this.adminTwoFactor.verifyLoginCode(adminId, code);
    if (!result.ok) {
      await this.adminSecurity.recordFailure(admin);
      throw new UnauthorizedException("That code didn't match. Use the newest code from your app, or a recovery code.");
    }
    const session: any = await this.issueLoginSession(admin, 'admin', ip, userAgent);
    session.data.twoFactor = { usedRecoveryCode: result.usedRecoveryCode, recoveryCodesLeft: result.recoveryCodesLeft };
    return session;
  }

  /** Second login step for a seller with two-factor on. Wrong codes count toward a 15-minute lock; a used code cannot be replayed. */
  async completeSellerTwoFactorLogin(challengeToken: string, code: string, ip?: string, userAgent?: string) {
    if (!this.memberTwoFactor) throw new UnauthorizedException('Two-factor sign-in is unavailable');
    const c = this.memberTwoFactor.verifyChallenge(challengeToken);
    if (c.kind !== 'seller') throw new UnauthorizedException('Your sign-in step expired. Enter your email and password again.');
    const seller: any = await this.databaseService.repositories.sellerModel.findById(c.memberId);
    if (!seller || seller.isDelete || seller.status === 'deleted' || seller.status === 'suspended' || (seller.tokenVersion ?? 0) !== c.tokenVersion) {
      throw new UnauthorizedException('Your sign-in step expired. Enter your email and password again.');
    }
    const result = await this.memberTwoFactor.verifyCode('seller', c.memberId, code);
    if (!result.ok) {
      this.logSellerSecurityEvent(c.memberId, 'security', 'two_factor_failed', `Wrong two-factor code from ${ip ?? 'unknown IP'}`, ip, userAgent, true);
      throw new UnauthorizedException("That code didn't match. Use the newest code from your app, or a recovery code.");
    }
    this.logSellerSecurityEvent(c.memberId, 'security', 'login_success', `Login (two-factor) from ${ip ?? 'unknown IP'}`, ip, userAgent, false);
    const session: any = await this.issueLoginSession(seller, 'seller', ip, userAgent);
    session.data.twoFactor = { usedRecoveryCode: result.usedRecoveryCode, recoveryCodesLeft: result.recoveryCodesLeft };
    return session;
  }

  /** Signs the access/refresh tokens once every login check has passed. */
  private async issueLoginSession(existingUser: any, role: string, ip?: string, userAgent?: string) {
    // tokenVersion is embedded so a suspend/deactivate action elsewhere
    // (which bumps the DB value) invalidates this token on its very next
    // request — see JwtAuthGuard's comparison against the current DB value.
    const adminClaims = role === 'admin' && this.adminSecurity ? await this.adminSecurity.onSuccess(existingUser, ip, userAgent) : {};
    const payload = {
      sub: existingUser._id,
      email: existingUser.email,
      role: existingUser.role,
      tokenVersion: existingUser.tokenVersion ?? 0,
      ...adminClaims,
      // Informational only — read from the resolved account, never from
      // client input. Buyer-only; undefined for seller/admin.
      storeId: role === 'user' ? ((existingUser as any).storeId ?? null) : undefined,
    };

    const token = this.jwtService.sign(payload);

    await this.redisService.set(
      token,
      existingUser._id.toString(),
      24 * 60 * 60,
    );

    // ✅ Refresh Token (long expiry)
    const refreshToken = this.signRefreshToken(payload);

    return {
      message: 'Login successful',
      success: true, // ye add karna zaroori hai
      data: {
        user: {
          // ⬅️ user object me rakhna
          id: existingUser._id,
          name: existingUser.name,
          email: existingUser.email,
          role: existingUser.role,
          image: existingUser.profileImage || null,
          ...(role === 'admin' ? { isSuperAdmin: !!existingUser.isSuperAdmin } : {}),
        },
        token: {
          // ⬅️ token object me rakhna
          accessToken: token,
          refreshToken: refreshToken,
        },
      },
    };
  }

  /** Seam for tests; production verifies against Apple's published keys. */
  protected async verifyAppleIdToken(token: string, audiences: string[]): Promise<any> {
    return appleSignin.verifyIdToken(token, { audience: audiences.length === 1 ? audiences[0] : audiences });
  }

  /**
   * Public wrapper for flows that need a fresh provider proof for an already-signed-in account (e.g. account-deletion
   * re-authentication). Returns the provider-verified email (or null). Throws UnauthorizedException on a bad token.
   */
  async verifyProviderIdentity(authProvider: string, socialId: string, token?: string): Promise<string | null> {
    return this.verifySocialToken(authProvider, socialId, token);
  }

  /** Verifies the provider token server-side so a forged socialId/email pair can't be used to hijack an account. */
  private async verifySocialToken(
    authProvider: string,
    socialId: string,
    token?: string,
    meta?: { aud?: string },
  ): Promise<string | null> {
    if (!token) {
      throw new UnauthorizedException(
        'Missing provider token for verification',
      );
    }

    if (authProvider === 'google') {
      // GOOGLE_CLIENT_ID may be a comma-separated list, so a new web client can be rolled out while apps that
      // still sign in with the old one keep working.
      const audiences = (process.env.GOOGLE_CLIENT_ID ?? '').split(',').map((a) => a.trim()).filter(Boolean);
      const ticket = await this.googleClient.verifyIdToken({
        idToken: token,
        audience: audiences.length === 1 ? audiences[0] : audiences,
      });
      const payload = ticket.getPayload();
      if (!payload || payload.sub !== socialId) {
        throw new UnauthorizedException('Invalid Google token');
      }
      return payload.email_verified && payload.email ? String(payload.email).toLowerCase() : null;
    } else if (authProvider === 'facebook') {
      const resp = await fetch(
        `https://graph.facebook.com/me?fields=id,email&access_token=${encodeURIComponent(token)}`,
      );
      const data: any = await resp.json();
      if (!data?.id || data.id !== socialId) {
        throw new UnauthorizedException('Invalid Facebook token');
      }
      return data.email ? String(data.email).toLowerCase() : null;
    } else if (authProvider === 'apple') {
      // APPLE_CLIENT_ID is a comma-separated list: the iOS bundle id (native sign-in) AND the web Services ID.
      const audiences = (process.env.APPLE_CLIENT_ID ?? '').split(',').map((a) => a.trim()).filter(Boolean);
      const payload: any = await this.verifyAppleIdToken(token, audiences);
      if (!payload || payload.sub !== socialId) {
        throw new UnauthorizedException('Invalid Apple token');
      }
      if (meta) meta.aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
      // Apple's email only counts as verified when the token says so (relay addresses are verified too).
      const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
      return emailVerified && payload.email ? String(payload.email).toLowerCase() : null;
    } else {
      throw new UnauthorizedException('Unsupported auth provider');
    }
  }

  /** Refresh tokens carry `typ:'refresh'` so an access token can never be replayed as one (and vice versa). */
  private signRefreshToken(payload: Record<string, any>): string {
    return this.jwtService.sign({ ...payload, typ: 'refresh' }, { expiresIn: '7d' });
  }

  /** True when an account already exists for this provider id (lets an email-less Apple/Facebook login continue). */
  private async hasProviderAccount(dto: SocialLoginDto): Promise<boolean> {
    const m: any = dto.role === 'seller' ? this.databaseService.repositories.sellerModel : this.databaseService.repositories.userModel;
    const storeScope = dto.role === 'seller' ? {} : { storeId: dto.storeId ?? null };
    return !!(await m.findOne({ providerId: dto.socialId, authProvider: dto.authProvider, ...storeScope }));
  }

  /**
   * Silent refresh: exchanges a valid refresh token for a new access token and a ROTATED refresh token.
   * Rejects access tokens (no `typ`), tokens from before a tokenVersion bump, and suspended / deleted / pending-deletion accounts.
   * (Refresh tokens issued before this endpoint existed have no `typ` and are refused — they were never usable anyway.)
   */
  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload?.typ !== 'refresh' || payload?.type || payload?.guest) throw new UnauthorizedException('Invalid refresh token');
    // Portal (cookie-mode) refresh tokens belong to a rotating family and only work through the CSRF-protected cookie path.
    if (payload?.fam) throw new UnauthorizedException('Invalid refresh token');
    const repos: any = this.databaseService.repositories;
    const model = payload.role === 'seller' ? repos.sellerModel : payload.role === 'user' ? repos.userModel : payload.role === 'admin' ? repos.adminModel : null;
    if (!model) throw new UnauthorizedException('Invalid refresh token');
    const account: any = await model.findById(payload.sub);
    if (!account || account.isDelete || ['deleted', 'suspended', 'pending_deletion'].includes(account.status)) {
      throw new UnauthorizedException('Session expired, please sign in again');
    }
    if ((account.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0)) {
      throw new UnauthorizedException('Session expired, please sign in again');
    }
    const { iat, exp, typ, ...claims } = payload;
    const accessToken = this.jwtService.sign(claims);
    await this.redisService.set(accessToken, String(account._id), 24 * 60 * 60);
    return { success: true, data: { token: { accessToken, refreshToken: this.signRefreshToken(claims) } } };
  }

  // ─────────────────────────── portal cookie sessions (5G.1): rotating refresh-token families ───────────────────────────
  private get families(): any { return (this.databaseService.repositories as any).refreshTokenFamilyModel; }
  private static readonly ROTATION_GRACE_MS = 10_000;

  /** Turns a freshly issued login result into a cookie session: a new family, a family-bound refresh JWT (for the cookie), and a body without the refresh token. */
  async toCookieSession(result: any): Promise<{ body: any; refreshToken: string }> {
    const issued = result?.data?.token?.refreshToken;
    const claims: any = issued ? this.jwtService.decode(issued) : null;
    if (!claims) throw new UnauthorizedException('Login failed');
    if (claims.role !== 'seller') throw new BadRequestException({ statusCode: 400, code: 'COOKIE_MODE_UNSUPPORTED', message: 'Cookie sessions are for seller accounts only' });
    const { iat, exp, typ, ...rest } = claims;
    const familyId = randomUUID();
    const jti = randomUUID();
    await this.families.create({ familyId, userId: String(rest.sub), role: rest.role, currentJtiHash: hashJti(jti), expiresAt: new Date(Date.now() + 7 * 86_400_000) });
    const refreshToken = this.jwtService.sign({ ...rest, typ: 'refresh', fam: familyId, jti }, { expiresIn: '7d' });
    return { body: { ...result, data: { ...result.data, token: { accessToken: result.data.token.accessToken } } }, refreshToken };
  }

  private async revokeFamily(familyId: string, reason: string) {
    await this.families.updateOne({ familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  }
  /** Revokes every portal session of this account (password reset, account deletion). */
  async revokeFamiliesForUser(userId: string, reason: string) {
    await this.families.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  }
  /** Logout from the cookie: revokes the family the token belongs to (silently ignores junk/expired tokens). */
  async revokeFamilyFromToken(refreshToken: string) {
    try {
      const p: any = this.jwtService.verify(refreshToken);
      if (p?.typ === 'refresh' && p?.fam) await this.revokeFamily(p.fam, 'logout');
    } catch { /* expired or invalid: nothing to revoke */ }
  }

  /**
   * Cookie-mode refresh: validates the family-bound refresh JWT, ROTATES it on every call and detects reuse.
   * A jti that was already rotated away revokes the whole family (401 REFRESH_REUSE) — except the immediately previous jti inside a
   * 10 s window (two tabs refreshing at once), which gets a retryable 401 REFRESH_IN_PROGRESS without revoking anything.
   */
  async refreshCookie(refreshToken: string) {
    let payload: any;
    try { payload = this.jwtService.verify(refreshToken); } catch { throw new UnauthorizedException('Invalid refresh token'); }
    if (payload?.typ !== 'refresh' || payload?.type || payload?.guest || !payload?.fam || !payload?.jti || payload?.role !== 'seller') {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const fam: any = await this.families.findOne({ familyId: payload.fam });
    if (!fam || fam.userId !== String(payload.sub) || fam.revokedAt || fam.expiresAt < new Date()) throw new UnauthorizedException('Session expired, please sign in again');
    const h = hashJti(payload.jti);
    if (h !== fam.currentJtiHash) {
      const recent = fam.rotatedAt && Date.now() - new Date(fam.rotatedAt).getTime() < AuthService.ROTATION_GRACE_MS;
      if (recent && h === fam.prevJtiHash) throw new UnauthorizedException({ statusCode: 401, code: 'REFRESH_IN_PROGRESS', message: 'Another refresh just completed; retry' });
      await this.revokeFamily(fam.familyId, 'reuse');
      throw new UnauthorizedException({ statusCode: 401, code: 'REFRESH_REUSE', message: 'Session revoked, please sign in again' });
    }
    const account: any = await this.databaseService.repositories.sellerModel.findById(payload.sub);
    if (!account || account.isDelete || ['deleted', 'suspended', 'pending_deletion'].includes(account.status) || (account.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0)) {
      await this.revokeFamily(fam.familyId, 'account_state');
      throw new UnauthorizedException('Session expired, please sign in again');
    }
    const newJti = randomUUID();
    const rotated = await this.families.findOneAndUpdate(
      { familyId: fam.familyId, currentJtiHash: h, revokedAt: null },
      { $set: { currentJtiHash: hashJti(newJti), prevJtiHash: h, rotatedAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000) }, $push: { usedJtis: { $each: [h], $slice: -50 } } },
    );
    if (!rotated) throw new UnauthorizedException({ statusCode: 401, code: 'REFRESH_IN_PROGRESS', message: 'Another refresh just completed; retry' });
    const { iat, exp, typ, fam: _f, jti: _j, ...claims } = payload;
    const accessToken = this.jwtService.sign(claims);
    await this.redisService.set(accessToken, String(account._id), 24 * 60 * 60);
    const newRefresh = this.jwtService.sign({ ...claims, typ: 'refresh', fam: fam.familyId, jti: newJti }, { expiresIn: '7d' });
    return { body: { success: true, data: { token: { accessToken } } }, refreshToken: newRefresh };
  }

  /** Social login resolves against the buyer (User) or seller (Seller) collection based on dto.role (default 'user') — same role-picks-the-model pattern as login()/signup(). */
  async socialLogin(dto: SocialLoginDto) {
    try {
      const meta: { aud?: string } = {};
      const verifiedEmail = await this.verifySocialToken(dto.authProvider, dto.socialId, dto.token, meta);
      const result: any = await this.finishSocialLogin(dto, verifiedEmail);
      // Apple: keep the Apple refresh token (encrypted) so the account's deletion can revoke it. Never fails the login.
      if (dto.authProvider === 'apple' && dto.role === 'seller' && dto.authorizationCode && this.appleTokens) {
        await this.appleTokens.storeFromAuthorizationCode(String(result?.data?.user?.id), dto.authorizationCode, meta.aud);
      }
      return result;
    } catch (error) {
      throw new UnauthorizedException(error.message || 'Social login failed');
    }
  }

  /**
   * Second half of social login, after the provider identity has ALREADY been verified by the caller
   * (`socialLogin` above for the platform's own Google app; the store-level OAuth code flow in
   * customer-social-login/ for a store's own Google/Facebook app). `verifiedEmail` must come from the
   * provider, never from the client.
   */
  async finishSocialLogin(dto: SocialLoginDto, verifiedEmail: string | null) {
    try {
      const {
        authProvider,
        socialId,
        userName,
        name,
        image,
        fcmToken,
        role,
        storeId,
      } = dto;
      // Same normalization as emailScope()/signup() — without it, a Google
      // account emailing as "Jane@Example.com" could silently create a
      // second row instead of matching an existing password-signup account
      // stored as "jane@example.com" for the same person.
      const claimedEmail = dto.email?.trim().toLowerCase();

      // Identity comes from the PROVIDER-verified email, never the client-sent one: a client can't claim
      // someone else's address to land in (or take over) their account.
      if (verifiedEmail && claimedEmail && verifiedEmail !== claimedEmail) {
        throw new UnauthorizedException('Email does not match the verified provider account');
      }
      let email = verifiedEmail ?? claimedEmail;
      const isAppleSeller = authProvider === 'apple' && role === 'seller';
      // Non-Apple providers keep the old rule: no email at all can only continue into an account already tied to this provider id.
      // Apple is keyed by `sub`: a brand-new Apple user can ALWAYS sign up (see the placeholder below).
      if (!email && !isAppleSeller && !(await this.hasProviderAccount(dto))) {
        throw new UnauthorizedException('No email available from the provider. Sign in with email, or share your email with the app.');
      }

      const targetRole: 'user' | 'seller' = role === 'seller' ? 'seller' : 'user';
      let accountModel;
      if (targetRole === 'seller') {
        accountModel = this.databaseService.repositories.sellerModel;
      } else {
        accountModel = this.databaseService.repositories.userModel;
      }

      // Both branches of this $or must stay scoped by storeId for a buyer —
      // otherwise a Google sign-in at Store A could resolve into an account
      // created by password signup at Store B (or the legacy global one)
      // for the same email, defeating per-store identity separation.
      const storeScope = targetRole === 'user' ? { storeId: storeId ?? null } : {};
      // No provider-verified email (e.g. Facebook without email permission, Apple relay) → match ONLY by the
      // verified provider id; never link an existing password account through an unverified, client-sent email.
      const matchers: any[] = [{ providerId: socialId, authProvider, ...storeScope }];
      if (verifiedEmail) matchers.unshift({ email: verifiedEmail, ...storeScope });
      let account = await accountModel.findOne({ $or: matchers });
      // Lets the web app count a Google sign-up as a new account in Solvexo's own website analytics.
      const isNewUser = !account;

      let emailIsPlaceholder = false;
      if (!account) {
        if (targetRole === 'user') {
          await this.assertValidStoreId(storeId);
        }
        if (isAppleSeller) {
          // Hide My Email / no email claim: the relay (or client-sent) address from the FIRST authorization is stored as the
          // account email. If it is missing, or already belongs to another account we are NOT allowed to link to (unverified
          // claim), fall back to a unique non-deliverable placeholder — never take over, never fail the sign-up.
          const taken = email ? !!(await accountModel.exists({ email })) : false;
          if (!email || taken) {
            email = `apple+${String(socialId).toLowerCase()}@apple-signin.invalid`;
            emailIsPlaceholder = true;
          }
        }
        account = new accountModel({
          name: name || userName,
          email,
          ...(emailIsPlaceholder ? { emailIsPlaceholder: true } : {}),
          role: targetRole,
          isVerified: true,
          authProvider,
          providerId: socialId,
          profileImage: image || null,
          fcmToken: fcmToken || undefined,
          ...(targetRole === 'user' ? { storeId: storeId ?? null } : {}),
        });
        await account.save();
        if (targetRole === 'seller') this.notifyAdminsNewSeller(account.name, account.email);
      } else {
        if (account.isDelete || account.status === 'deleted') {
          throw new UnauthorizedException('This account has been deleted');
        }
        if (account.status === 'suspended') {
          throw new UnauthorizedException(
            'This account has been suspended. Please contact support.',
          );
        }

        let changed = false;
        if (!account.providerId) {
          account.providerId = socialId;
          changed = true;
        }
        if (!account.authProvider) {
          account.authProvider = authProvider;
          changed = true;
        }
        if (fcmToken && account.fcmToken !== fcmToken) {
          account.fcmToken = fcmToken;
          changed = true;
        }
        if (!account.isVerified) {
          account.isVerified = true;
          changed = true;
        }
        if (changed) await account.save();
      }

      if (targetRole === 'seller') {
        this.logSellerSecurityEvent(
          account._id.toString(),
          'security',
          'login_success',
          `Login via ${authProvider}`,
          undefined,
          undefined,
          false,
        );
      }

      const payload = {
        sub: account._id,
        email: account.email,
        role: account.role,
        tokenVersion: account.tokenVersion ?? 0,
        storeId: targetRole === 'user' ? ((account as any).storeId ?? null) : undefined,
      };
      const accessToken = this.jwtService.sign(payload);
      await this.redisService.set(
        accessToken,
        account._id.toString(),
        24 * 60 * 60,
      );
      const refreshToken = this.signRefreshToken(payload);

      return {
        message: 'Social login successful',
        success: true,
        data: {
          isNewUser,
          user: {
            id: account._id,
            name: account.name,
            email: account.email,
            role: account.role,
            image: account.profileImage || null,
          },
          token: {
            accessToken,
            refreshToken,
          },
        },
      };
    } catch (error) {
      throw new UnauthorizedException(error.message || 'Social login failed');
    }
  }

  async resendOtp(email: string, role: string, storeId?: string) {
    try {
      // OTP resend only ever applies to a not-yet-verified buyer/seller
      // registration — admin accounts are always created pre-verified via
      // createAdmin() below, so there is no legitimate 'admin' case here.
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne(this.emailScope(email, role, storeId));
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.isVerified) {
        throw new UnauthorizedException('User already verified');
      }

      const newOtp = generateOtp();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      user.otp = newOtp;
      user.otpAttempts = 0;
      user.otpExpiresAt = otpExpiresAt;
      await user.save();

      await this.sendOtpMail(user.email, newOtp, role, storeId);

      return {
        message: 'New OTP sent successfully to your email',
        success: true,
        data: {
          userId: user._id,
        },
      };
    } catch (error) {
      throw new UnauthorizedException(error.message || 'Resend OTP failed');
    }
  }

  async verifyOtp(email: string, role: string, otp: string, storeId?: string) {
    try {
      // Registration-verification only — activates a not-yet-verified
      // buyer/seller account. Admin accounts are always created
      // pre-verified via createAdmin() below, so there is no legitimate
      // 'admin' case here (closes the other half of the old public
      // self-registration-as-admin path, alongside RegisterDto's fix).
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne(this.emailScope(email, role, storeId));
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.isVerified) {
        throw new UnauthorizedException('User already verified');
      }

      await assertOtpAttempt(userModel, user._id, otp);

      if (user.otpExpiresAt && new Date() > user.otpExpiresAt) {
        throw new UnauthorizedException('OTP has expired');
      }

      const wasVerified = !!user.isVerified;
      user.isVerified = true;
      user.otp = null as any;
      user.otpExpiresAt = null as any;
      await user.save();
      if (role === 'seller' && !wasVerified) this.notifyAdminsNewSeller((user as any).name, user.email);

      const payload = {
        sub: user._id,
        email: user.email,
        role: user.role,
        tokenVersion: user.tokenVersion ?? 0,
        storeId: role === 'user' ? ((user as any).storeId ?? null) : undefined,
      };
      // Was `expiresIn: '1h'` + a 30-minute Redis TTL — a freshly-verified
      // account got session-killed after 30 minutes (JwtAuthGuard rejects
      // once the Redis key expires, regardless of the JWT's own exp claim),
      // vs. ~24h for the exact same account signing in normally right after
      // (see login() above, which signs with the module default and sets a
      // 24h Redis TTL). There's also no silent-refresh safety net for this —
      // no `/api/auth/refresh` route exists on the backend at all, so the
      // refreshToken returned below is currently never actually used by
      // anything. Matching login()'s session length here removes the
      // shorter, inconsistent session entirely rather than needing a working
      // refresh flow to paper over it.
      const token = this.jwtService.sign(payload);

      await this.redisService.set(token, user._id.toString(), 24 * 60 * 60);

      const refreshToken = this.signRefreshToken(payload);

      return {
        message: 'OTP verified successfully',
        success: true,
        data: {
          user: {
            // ✅ user object
            id: user._id, // _id ko id me change karna better rahega Dart model ke liye
            name: user.name,
            email: user.email,
            phone: user.phone,
            address: user.address,
          },
          token: {
            // ✅ token object
            accessToken: token,
            refreshToken: refreshToken,
          },
        },
      };
    } catch (error) {
      throw new UnauthorizedException(
        error.message || 'OTP verification failed',
      );
    }
  }

  // Deliberately still supports role:'admin' here (and in resetPassword
  // below) — unlike signup/verifyOtp, this never creates an account. It
  // only emails an OTP to the address already on file for an EXISTING
  // record, so an attacker gains nothing by requesting it for someone
  // else's admin email; removing it would just lock real admins out of
  // self-service password recovery for no security benefit.
  async forgotPassword(email: string, role: string, storeId?: string) {
    try {
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne(this.emailScope(email, role, storeId));

      // Same response whether or not the account exists — an "email not
      // found" error here would let anyone enumerate which emails are
      // actually registered on Solvexo. Only genuinely sends an OTP when
      // there's a real account to send it to; a non-existent email silently
      // no-ops but still reports success, exactly as a real user's request
      // would look from the outside.
      if (user) {
        const otp = generateOtp();
        const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        user.otp = otp;
        user.otpAttempts = 0;
        user.otpExpiresAt = otpExpiresAt;
        await user.save();

        await this.sendOtpMail(user.email, otp, role, storeId);
      }

      return {
        message: 'If an account exists for this email, a password reset code has been sent.',
        success: true,
        data: null,
      };
    } catch (error) {
      throw new UnauthorizedException(
        error.message || 'Forgot password failed',
      );
    }
  }

  async resetPassword(
    email: string,
    role: string,
    otp: string,
    newPassword: string,
    storeId?: string,
  ) {
    try {
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne(this.emailScope(email, role, storeId));
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      await assertOtpAttempt(userModel, user._id, otp);

      const now = new Date();
      if (!user.otpExpiresAt || now > user.otpExpiresAt) {
        throw new UnauthorizedException('OTP has expired');
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);

      user.password = hashedPassword;
      user.otp = null;
      user.otpExpiresAt = null;
      // A reset must kill every session issued with the old password:
      // JwtAuthGuard rejects any token whose tokenVersion claim is stale
      // (Redis sessions are keyed by token, so they can't be enumerated).
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      await user.save();
      if (role === 'seller') await this.revokeFamiliesForUser(String(user._id), 'password_reset');

      return {
        message: 'Your password has been changed successfully',
        success: true,
      };
    } catch (error) {
      throw new UnauthorizedException(error.message || 'Password reset failed');
    }
  }

  /** Read-only check used ONLY by the forgot-password OTP screen, so it can
   *  reject a wrong/expired code immediately instead of silently carrying it
   *  forward to the new-password step (which is what happened before this
   *  existed — resetPassword was the only thing that ever validated the
   *  code, one whole screen later). Deliberately does NOT touch `user.otp`/
   *  `otpExpiresAt` — the code must still work when resetPassword is called
   *  right after this with the same otp, and a correct-but-not-yet-final
   *  verify here must never burn a code the user hasn't actually used yet. */
  async verifyResetOtp(email: string, role: string, otp: string, storeId?: string) {
    try {
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid user type');
      }

      const user = await userModel.findOne(this.emailScope(email, role, storeId));
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      await assertOtpAttempt(userModel, user._id, otp);

      if (!user.otpExpiresAt || new Date() > user.otpExpiresAt) {
        throw new UnauthorizedException('OTP has expired');
      }

      return { message: 'OTP verified', success: true };
    } catch (error) {
      throw new UnauthorizedException(error.message || 'OTP verification failed');
    }
  }

  /** Mirrors AdminConfigService.getEnabledCurrencies's *read* (not its
   *  lazy-seed-on-first-call side effect — by the time a real buyer sets a
   *  currency preference, checkout has already run at least once on this
   *  platform and seeded it) so this is validated against the real, dynamic
   *  Markets list, not the old fixed SUPPORTED_CURRENCIES array (retired —
   *  see checkout.service.ts's resolveCheckoutCurrency). Reads the
   *  PlatformConfig document directly rather than injecting
   *  AdminConfigService: AdminConfigModule already imports AuthModule (for
   *  its own guards), so the reverse import here would be circular. */
  private async assertValidCurrencyPreference(code?: string): Promise<void> {
    if (!code) return;
    const config: any = await this.databaseService.repositories.platformConfigModel.findOne({}).lean();
    const enabled = ['USD', ...((config?.fxConfig?.enabledCurrencies ?? []).map((c: any) => c.code))];
    if (!enabled.includes(code)) {
      throw new BadRequestException(`Unsupported currency "${code}" — must be one of: ${enabled.join(', ')}`);
    }
  }

  async editProfile(userId: string, role: string, dto: UpdateProfileDto) {
    try {
      await this.assertValidCurrencyPreference(dto.currencyPreference);
      let userModel;

      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else if (role === 'staff') {
        throw new BadRequestException('Staff update their profile from the Account page.');
      } else {
        throw new BadRequestException('Invalid role');
      }

      // Explicit field list — `dto` arrives as the raw request body (this
      // controller had no whitelisting pipe), so `$set: dto` let a caller
      // overwrite privileged fields (status, isVerified, tokenVersion,
      // password, Stripe ids, storeId, ...). Only profile fields pass.
      const allowed = ['name', 'phone', 'address', 'profileImage', 'fcmToken', 'currencyPreference'] as const;
      const update: Record<string, any> = {};
      for (const key of allowed) {
        if ((dto as any)?.[key] !== undefined) update[key] = (dto as any)[key];
      }

      const user = await userModel
        .findByIdAndUpdate(
          userId,
          { $set: update },
          { new: true, runValidators: true },
        )
        .select('-password -otp -otpExpiresAt');

      if (!user) {
        throw new BadRequestException('User not found');
      }

      return {
        message: 'Profile updated successfully',
        success: true,
        data: user,
      };
    } catch (error) {
      throw new BadRequestException(
        error.message || 'Failed to update profile',
      );
    }
  }

  /** Profile of an admin's read-only "view as store" session (staff-shaped token; there is no StaffMember row). */
  async getViewAsProfile(user: any) {
    const [admin, store]: any[] = await Promise.all([
      this.databaseService.repositories.adminModel.findById(user.viewAs).select('name email').lean(),
      this.databaseService.repositories.storeModel.findById(user.storeId).select('name').lean(),
    ]);
    return { message: 'Profile fetched successfully', success: true, data: {
      _id: user.viewAs, name: `${admin?.name ?? 'Admin'} (admin view)`, email: admin?.email ?? '', phone: '', address: '', isVerified: true, profileImage: null,
      status: 'active', role: 'staff', currencyPreference: null, storeId: user.storeId, storeName: store?.name ?? null, staffRoleName: 'Admin — read-only view', permissions: user.permissions ?? [],
    } };
  }

  async getProfile(userId: string, role: string) {
    try {
      if (role === 'staff') {
        return { message: 'Profile fetched successfully', success: true, data: await buildStaffProfile(this.databaseService.repositories, userId) };
      }
      let userModel;

      // 1️⃣ Role ke base pe model select
      if (role === 'user') {
        userModel = this.databaseService.repositories.userModel;
      } else if (role === 'seller') {
        userModel = this.databaseService.repositories.sellerModel;
      } else if (role === 'admin') {
        userModel = this.databaseService.repositories.adminModel;
      } else {
        throw new UnauthorizedException('Invalid role');
      }

      // 2️⃣ User find karo
      const user = await userModel.findById(userId).select('-password -otp');

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // 3️⃣ Return data
      return {
        message: 'Profile fetched successfully',
        success: true,
        data: user,
      };
    } catch (error) {
      throw new UnauthorizedException(
        error.message || 'Failed to fetch profile',
      );
    }
  }

  /** The only way an admin account can be created now that public
   *  registration is restricted to 'user'|'seller'. Only reachable via
   *  POST /api/auth/admin/create-admin, which is guarded by
   *  JwtAuthGuard + Roles('admin') — so only an already-logged-in admin
   *  can call it. Created pre-verified (no OTP round-trip needed, since
   *  the caller is already a trusted, authenticated admin). */
  async createAdmin(dto: CreateAdminDto, actor: { adminId: string; ip?: string; userAgent?: string }) {
    try {
      const adminModel = this.databaseService.repositories.adminModel;

      const existing = await adminModel.findOne({ email: dto.email });
      if (existing) {
        throw new UnauthorizedException('An admin with this email already exists');
      }

      const hashedPassword = await bcrypt.hash(dto.password, 10);

      const admin = new adminModel({
        name: dto.name,
        email: dto.email,
        password: hashedPassword,
        phone: dto.phone,
        address: dto.address,
        role: 'admin',
        isVerified: true,
        status: 'active',
      });
      await admin.save();

      try {
        await this.activityLogService.log({
          category: 'security',
          action: 'admin_account_created',
          description: `Admin account "${dto.name}" (${dto.email}) created`,
          actorId: actor.adminId,
          actorRole: 'admin',
          targetId: String(admin._id),
          targetType: 'admin',
          ip: actor.ip,
          userAgent: actor.userAgent,
          isSecurityAlert: true,
        });
      } catch {
        // logging must never break account creation
      }

      return {
        message: 'Admin account created successfully',
        success: true,
        data: {
          id: admin._id,
          name: admin.name,
          email: admin.email,
        },
      };
    } catch (error) {
      throw new UnauthorizedException(
        error.message || 'Failed to create admin account',
      );
    }
  }
}
