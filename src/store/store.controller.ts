/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Patch, Body, Req, Res, Param, Query, UseGuards, ForbiddenException } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreService } from './store.service';
import { UpdateStoreCustomerDto } from './dto/update-store-customer.dto';
import { BulkTagCustomersDto } from './dto/bulk-tag-customers.dto';
import { BulkArchiveCustomersDto } from './dto/bulk-archive-customers.dto';
import { resolveBuyerStoreScope } from '../common/store-scope.util';

@Controller('api/store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('create-store')
  async createStore(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.storeService.createStore(userId, body);
  }

  // Store-independent requirements preview — used by onboarding BEFORE a
  // store exists (the store isn't created until the final submit step, so
  // there's no storeId yet to scope the existing `:storeId/verification/
  // requirements` route to). Pure function of country+businessType, no
  // ownership check needed. Declared as a literal segment ahead of the
  // `:storeId/...` block below so `:storeId` never swallows "verification"
  // as if it were a store id.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('verification/requirements-preview')
  async previewVerificationRequirementsStandalone(@Query() query: { country?: string; businessType?: string }) {
    return this.storeService.previewVerificationRequirementsStandalone(query);
  }

  // Same "before a store exists" precedent as the route above — used by
  // Onboarding's currency step to pre-fill (never force) a suggested
  // currency from the seller's IP-detected country.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('suggest-location')
  async suggestLocation(@Req() req: any) {
    return this.storeService.getSuggestedLocation(req.ip);
  }

  // seller ke saare stores
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('my-stores')
  async getMyStores(@Req() req: any) {
    const { userId } = req.user;
    return this.storeService.getMyStores(userId);
  }

  // Deliberately left without a mandatory auth guard — POS pin-login and other
  // shared-device flows fetch a store before any seller session exists.
  // `OptionalJwtAuthGuard` lets an authenticated *owning* seller additionally
  // receive their own contact/stat fields (see StoreService.getStoreById)
  // without exposing that PII to anonymous/other callers.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('getStoreById/:storeId')
  async getStoreById(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.getStoreById(storeId, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.domains.manage')
  @Patch(':storeId/custom-domain')
  async setCustomDomain(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { domain: string | null }) {
    return this.storeService.setCustomDomain(actingSellerId(req.user), storeId, body.domain ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.domains.manage')
  @Post(':storeId/custom-domain/verify')
  async verifyCustomDomain(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.verifyCustomDomain(actingSellerId(req.user), storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/privacy')
  async updateStorePrivacy(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { privacyMode: 'public' | 'password' | 'coming_soon'; password?: string }) {
    return this.storeService.updateStorePrivacy(req.user.userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/robots-txt')
  async updateStoreRobotsTxt(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { robotsTxtOverride: string | null }) {
    return this.storeService.updateStoreRobotsTxt(req.user.userId, storeId, body?.robotsTxtOverride ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/white-label')
  async setWhiteLabel(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { enabled: boolean }) {
    return this.storeService.setWhiteLabel(req.user.userId, storeId, !!body.enabled);
  }

  // Solvexo POS is a single, already-published, PAID Google Play listing —
  // Google Play collects payment directly from the merchant on install, so
  // there is nothing to sell or gate on our side. This just hands back the
  // listing URL (Android only for now) so the dashboard can render a QR/link
  // to it. No Stripe, no per-store state — store-independent, so it's a
  // literal segment rather than nested under `:storeId/...`.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('pos-app-info')
  getPosAppInfo() {
    return this.storeService.getPosAppInfo();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/pinned-products')
  async updatePinnedProducts(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { productIds: string[] }) {
    return this.storeService.updatePinnedProducts(req.user.userId, storeId, body.productIds ?? []);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/announcement')
  async updateAnnouncementBar(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.storeService.updateAnnouncementBar(req.user.userId, storeId, body);
  }

  // ── Seller business verification (Leads review) ────────────────────────
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/verification')
  async getVerification(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.getVerification(req.user.userId, storeId);
  }

  // Live "what would I need" preview as the seller picks country/business
  // type, before anything is saved — see StoreService.getVerificationRequirements.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/verification/requirements')
  async getVerificationRequirements(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: { country?: string; businessType?: string },
  ) {
    return this.storeService.getVerificationRequirements(req.user.userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/verification')
  async updateVerification(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.storeService.updateVerification(req.user.userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/verification/documents')
  async attachVerificationDocument(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() body: { type: string; publicId: string; resourceType: string; fileName: string },
  ) {
    return this.storeService.attachVerificationDocument(req.user.userId, storeId, body.type, {
      publicId: body.publicId,
      resourceType: body.resourceType,
      fileName: body.fileName,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/verification/submit')
  async submitVerification(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.submitVerification(req.user.userId, storeId);
  }

  // Real "Manage general store settings" — previously seller-only with no
  // staff path at all. NOTE: storeId travels in the body, not a route
  // param, so `PermissionsGuard`'s store-scope pin is a no-op here (same
  // disclosed shape as stripe-connect.controller.ts) — real ownership is
  // still enforced by `updateStore`'s own service-layer check.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.general.manage')
  @Post('update-store')
  async updateStore(@Req() req: any, @Body() body: any) {
    const { storeId, ...updateData } = body;
    // `taxRate` is Shopify's real, separate "Manage taxes" permission —
    // fused into this same general-settings endpoint (Store has no
    // dedicated tax route), so the split is enforced imperatively here,
    // same pattern as products' price/cost split.
    if (req.user.role === 'staff' && updateData.taxRate !== undefined) {
      const permissions: string[] = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      if (!permissions.includes('settings.taxes.manage')) {
        throw new ForbiddenException("Your staff account doesn't have permission to manage tax settings.");
      }
    }
    return this.storeService.updateStore(actingSellerId(req.user), storeId, updateData);
  }

  // ── Builder APIs ──────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('save-builder-config')
  async saveBuilderConfig(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.storeService.saveBuilderConfig(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('builder-config/:storeId')
  async getBuilderConfig(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.storeService.getBuilderConfig(userId, storeId);
  }

  // ── Public Storefront APIs ────────────────────────────────────────────────

  // Static segments ('public', 'public/top') must be declared before the
  // 'public/:slug' param route below, or they'd be swallowed by it.
  @Get('public')
  async listPublicStores(@Query() query: any) {
    return this.storeService.listPublicStores(query);
  }

  @Get('public/top')
  async getTopStores(@Query('limit') limit?: string) {
    return this.storeService.getTopStores(Math.min(20, parseInt(limit || '10') || 10));
  }

  @Get('public/platform-stats')
  async getPlatformStats() {
    return this.storeService.getPlatformStats();
  }

  // Real, dynamic Markets currency list (AdminConfigService.getEnabledCurrencies)
  // — public/no-auth since Onboarding's currency step, a buyer's currency
  // switcher, and a seller's own "Markets" card all need this before/without
  // necessarily having a seller session.
  @Get('public/enabled-currencies')
  async getEnabledCurrencies() {
    return { success: true, data: await this.storeService.getEnabledCurrencies() };
  }

  // Registered BEFORE 'public/:slug' — same reasoning as 'resolve-domain'
  // below. Public/no-auth — a storefront visitor triggering this (on first
  // landing on a store's subdomain) is usually not logged in yet.
  @Get('public/:storeId/suggest-location')
  async suggestLocationForStore(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeService.getSuggestedLocationForStore(storeId, req.ip);
  }

// Registered BEFORE 'public/:slug' — a static path segment must be matched
  // first, or Nest would swallow 'resolve-domain' as `:slug`.
  @Get('public/resolve-domain')
  async resolveStoreByDomain(@Query('host') host: string) {
    return this.storeService.getPublicStoreByDomain(host);
  }

  @Get('public/:slug')
  async getPublicStore(@Param('slug') slug: string) {
    return this.storeService.getPublicStore(slug);
  }

  // Storefront password-gate submission — a visibility convenience, not an
  // account-security boundary (see `Store.storePasswordHash`'s schema doc
  // comment), so this only needs the same lightweight rate limiting every
  // other unauthenticated write in this codebase uses, not a full lockout
  // mechanism.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/:storeId/verify-password')
  async verifyStorePassword(@Param('storeId') storeId: string, @Body() body: { password: string }) {
    return this.storeService.verifyStorePassword(storeId, body?.password ?? '');
  }

  // Plain text, not the standard `{success, data}` JSON envelope — a
  // crawler expects a literal robots.txt body. See
  // `StoreService.getPublicStoreRobotsTxt`'s own doc comment for the
  // disclosed gap on actually routing `<slug>.solvexo.store/robots.txt`
  // here (same category as the Custom Domain TLS caveat elsewhere in this
  // codebase) — this endpoint itself is the complete application-layer half.
  @SkipThrottle()
  @Get('public/:storeId/robots.txt')
  async getPublicStoreRobotsTxt(@Param('storeId') storeId: string, @Res() res: Response) {
    const body = await this.storeService.getPublicStoreRobotsTxt(storeId);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(body);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public/:storeId/products')
  async getPublicStoreProducts(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    return this.storeService.getPublicStoreProducts(storeId, query, req.user?.userId ?? null);
  }

  @Get('public/:storeId/filters')
  async getPublicStoreFilters(@Param('storeId') storeId: string) {
    return this.storeService.getPublicStoreFilters(storeId);
  }


  // ── Customers (staff-facing) ─────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.view')
  @Get(':storeId/customers')
  async getStoreCustomers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.storeService.getStoreCustomers(actingSellerId(req.user), storeId, query);
  }

  // Registered BEFORE ':customerId' — a literal 'export' segment must be
  // matched first, same static-before-parameterized precedent used
  // elsewhere in this controller (e.g. 'public/resolve-domain').
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.export')
  @Get(':storeId/customers/export')
  async exportStoreCustomers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any, @Res() res: Response) {
    const csv = await this.storeService.exportStoreCustomers(actingSellerId(req.user), storeId, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customers-${storeId}.csv"`);
    res.send(csv);
  }

  // Real "Create customer profile" — the Tier-2 audit's disclosed gap
  // (edit existed, no seller-initiated create). See
  // StoreService.createStoreCustomer's own doc comment.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.edit')
  @Post(':storeId/customers')
  async createStoreCustomer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: { name: string; email: string; phone?: string },
  ) {
    return this.storeService.createStoreCustomer(actingSellerId(req.user), storeId, dto, req.ip, req.headers['user-agent']);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.edit')
  @Post(':storeId/customers/bulk-tag')
  async bulkTagCustomers(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkTagCustomersDto) {
    return this.storeService.bulkTagCustomers(actingSellerId(req.user), storeId, dto, req.ip, req.headers['user-agent']);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.edit')
  @Patch(':storeId/customers/bulk-archive')
  async bulkArchiveCustomers(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkArchiveCustomersDto) {
    return this.storeService.bulkArchiveCustomers(actingSellerId(req.user), storeId, dto, req.ip, req.headers['user-agent']);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.edit')
  @Patch(':storeId/customers/:customerId')
  async updateStoreCustomer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('customerId') customerId: string,
    @Body() dto: UpdateStoreCustomerDto,
  ) {
    return this.storeService.updateStoreCustomer(actingSellerId(req.user), storeId, customerId, dto, req.ip, req.headers['user-agent']);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.edit')
  @Patch(':storeId/customers/:customerId/meta')
  async updateStoreCustomerMeta(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('customerId') customerId: string,
    @Body() dto: { tags?: string[]; notes?: string; marketingOptIn?: boolean },
  ) {
    return this.storeService.updateStoreCustomerMeta(actingSellerId(req.user), storeId, customerId, dto, req.ip, req.headers['user-agent']);
  }
}