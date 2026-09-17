/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete, Put,
  Param, Body, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { BookableServicesService } from './bookable-services.service';
import { BookingsService } from './bookings.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { CreatePackageDto } from './dto/create-package.dto';
import { UpdatePackageDto } from './dto/update-package.dto';
import { BookAppointmentDto } from './dto/book-appointment.dto';
import { PurchasePackageDto } from './dto/purchase-package.dto';
import { RescheduleBookingDto } from './dto/reschedule-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { resolveBuyerStoreScope } from '../common/store-scope.util';

@ApiTags('Bookings')
@Controller('api/bookings')
export class BookingsController {
  constructor(
    private readonly servicesService: BookableServicesService,
    private readonly bookingsService: BookingsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — static routes registered first (same "static before parameterized"
  // convention used by SubscriptionsController/Orders/POS).
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('public/:storeId/services')
  browseServices(@Param('storeId') storeId: string) {
    return this.servicesService.browseServices(storeId);
  }

  @Get('public/:storeId/services/:serviceId')
  getServiceDetail(@Param('storeId') storeId: string, @Param('serviceId') serviceId: string) {
    return this.servicesService.getServiceDetail(storeId, serviceId);
  }

  @Get('public/:storeId/services/:serviceId/slots')
  getSlots(
    @Param('storeId') storeId: string,
    @Param('serviceId') serviceId: string,
    @Query('date') date: string,
  ) {
    return this.servicesService.getSlots(storeId, serviceId, date);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  // Same tighter-than-default ceiling as Subscriptions' POST subscribe — this
  // endpoint moves money and creates provider-side charge objects.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('book')
  book(@Req() req: any, @Body() dto: BookAppointmentDto) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, (dto as any).storeId);
    return this.bookingsService.book(req.user.userId, dto, req.headers['idempotency-key'], storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('packages/:packageId/purchase')
  purchasePackage(@Req() req: any, @Param('packageId') packageId: string, @Body() _dto: PurchasePackageDto) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, (_dto as any)?.storeId);
    return this.bookingsService.purchasePackage(req.user.userId, packageId, req.headers['idempotency-key'], storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my')
  listMyBookings(@Req() req: any, @Query() query: any) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, query.storeId);
    return this.bookingsService.listMyBookings(req.user.userId, query, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/packages')
  listMyPackages(@Req() req: any, @Query('storeId') storeIdQuery: string) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.bookingsService.listMyPackages(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/:id')
  getMyBookingById(@Req() req: any, @Param('id') id: string, @Query('storeId') storeIdQuery: string) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.bookingsService.getMyBookingById(req.user.userId, id, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/cancel')
  cancelMyBooking(@Req() req: any, @Param('id') id: string, @Body() body: CancelBookingDto) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, (body as any)?.storeId);
    return this.bookingsService.cancelMyBooking(req.user.userId, id, body.reason, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/reschedule')
  rescheduleMyBooking(@Req() req: any, @Param('id') id: string, @Body() dto: RescheduleBookingDto) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, (dto as any)?.storeId);
    return this.bookingsService.rescheduleMyBooking(req.user.userId, id, dto, storeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — store-scoped (parameterized routes registered last)
  // ═══════════════════════════════════════════════════════════════════════════

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/services')
  createService(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateServiceDto) {
    return this.servicesService.createService(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/services')
  listServices(@Req() req: any, @Param('storeId') storeId: string) {
    return this.servicesService.listServices(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/services/:serviceId')
  getService(@Req() req: any, @Param('storeId') storeId: string, @Param('serviceId') serviceId: string) {
    return this.servicesService.getService(req.user.userId, storeId, serviceId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/services/:serviceId')
  updateService(
    @Req() req: any, @Param('storeId') storeId: string, @Param('serviceId') serviceId: string, @Body() dto: UpdateServiceDto,
  ) {
    return this.servicesService.updateService(req.user.userId, storeId, serviceId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/services/:serviceId')
  archiveService(@Req() req: any, @Param('storeId') storeId: string, @Param('serviceId') serviceId: string) {
    return this.servicesService.archiveService(req.user.userId, storeId, serviceId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/services/:serviceId/availability')
  getAvailability(@Req() req: any, @Param('storeId') storeId: string, @Param('serviceId') serviceId: string) {
    return this.servicesService.getAvailability(req.user.userId, storeId, serviceId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Put(':storeId/services/:serviceId/availability')
  setAvailability(
    @Req() req: any, @Param('storeId') storeId: string, @Param('serviceId') serviceId: string, @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.servicesService.setAvailability(req.user.userId, storeId, serviceId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/services/:serviceId/packages')
  listPackages(@Req() req: any, @Param('storeId') storeId: string, @Param('serviceId') serviceId: string) {
    return this.servicesService.listPackages(req.user.userId, storeId, serviceId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/services/:serviceId/packages')
  createPackage(
    @Req() req: any, @Param('storeId') storeId: string, @Param('serviceId') serviceId: string, @Body() dto: CreatePackageDto,
  ) {
    return this.servicesService.createPackage(req.user.userId, storeId, serviceId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/services/:serviceId/packages/:packageId')
  updatePackage(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('serviceId') serviceId: string,
    @Param('packageId') packageId: string,
    @Body() dto: UpdatePackageDto,
  ) {
    return this.servicesService.updatePackage(req.user.userId, storeId, serviceId, packageId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/services/:serviceId/packages/:packageId')
  archivePackage(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('serviceId') serviceId: string,
    @Param('packageId') packageId: string,
  ) {
    return this.servicesService.archivePackage(req.user.userId, storeId, serviceId, packageId);
  }

  // ── Bookings — "dashboard" is a static suffix and must be registered
  // before the ":id" parameterized routes below it. ──────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/bookings/dashboard')
  getBookingsDashboard(@Req() req: any, @Param('storeId') storeId: string) {
    return this.bookingsService.getSellerDashboard(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/bookings')
  listSellerBookings(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.bookingsService.listSellerBookings(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/bookings/:id')
  getSellerBookingById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.bookingsService.getSellerBookingById(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/bookings/:id/confirm')
  confirmBooking(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.bookingsService.confirmBooking(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/bookings/:id/complete')
  completeBooking(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.bookingsService.completeBooking(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/bookings/:id/cancel')
  sellerCancelBooking(
    @Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: CancelBookingDto,
  ) {
    return this.bookingsService.sellerCancelBooking(req.user.userId, storeId, id, body.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/bookings/:id/reschedule')
  sellerRescheduleBooking(
    @Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: RescheduleBookingDto,
  ) {
    return this.bookingsService.sellerRescheduleBooking(req.user.userId, storeId, id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/bookings/:id/meeting-link')
  setMeetingLink(
    @Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: { meetingLink: string },
  ) {
    return this.bookingsService.setMeetingLink(req.user.userId, storeId, id, body.meetingLink);
  }
}
