/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, UseGuards,
  UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MessagingService } from './messaging.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { StartConversationDto } from './dto/start-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { BlockDto } from './dto/block.dto';
import { ReportDto } from './dto/report.dto';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { actingSellerId } from '../common/acting-seller-id.util';

// Real staff-permission gate, added alongside the existing buyer/seller/
// admin access. This controller has NO `:storeId` route param anywhere
// (storeId only ever arrives via body/query) — `PermissionsGuard`'s usual
// storeId-route-param pin is therefore a no-op here, so every method that
// resolves a conversation instead pins a staff caller to their own JWT
// `storeId` claim explicitly inside `MessagingService` (see
// `assertConversationAccess`'s doc comment). `@RequirePermission` here is
// purely the "does this staff member have ANY messaging access at all"
// gate; the store-scope enforcement lives in the service, not this guard.
// Buyer-only/admin-only routes below are untouched — staff never reaches
// those (no `'staff'` in their own `@Roles(...)`).
const STAFF_VIEW = ['messaging.view', 'messaging.manage'];
const STAFF_MANAGE = 'messaging.manage';

@ApiTags('Messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/messaging')
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) { }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Starts or retrieves a conversation with a store, acting as the buyer side.
  // Also open to 'seller' accounts — a seller is still allowed to message a
  // DIFFERENT store as a customer (see the self-message guard in the service).
  // Deliberately NOT opened to 'staff' — starting a NEW conversation as the
  // buyer side makes no sense for a store-scoped staff login.
  @UseGuards(RolesGuard)
  @Roles('user', 'seller')
  @Post('conversations')
  startConversation(@Req() req: any, @Body() dto: StartConversationDto) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, dto.storeId);
    return this.messagingService.startOrGetConversation(req.user.userId, dto, storeId);
  }

  // Seller/buyer/admin/staff lists their inbox
  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'admin', 'staff')
  @RequirePermission(...STAFF_VIEW)
  @Get('conversations')
  getConversations(@Req() req: any, @Query() query: any) {
    return this.messagingService.getConversations(actingSellerId(req.user), req.user.role, query, req.user.storeId);
  }

  // ── Static routes BEFORE /:id ─────────────────────────────────────────────

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'admin', 'staff')
  @RequirePermission(...STAFF_VIEW)
  @Get('conversations/search')
  searchConversations(@Req() req: any, @Query('q') q: string, @Query('storeId') storeId?: string) {
    return this.messagingService.searchConversations(actingSellerId(req.user), req.user.role, q, storeId, req.user.storeId);
  }

  // ── Parameterized routes ──────────────────────────────────────────────────

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'admin', 'staff')
  @RequirePermission(...STAFF_VIEW)
  @Get('conversations/:id')
  getConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.getConversationById(actingSellerId(req.user), req.user.role, id, req.user.storeId);
  }

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Patch('conversations/:id/archive')
  archiveConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.archiveConversation(actingSellerId(req.user), id, true, req.user.role, req.user.storeId);
  }

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Patch('conversations/:id/restore')
  restoreConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.archiveConversation(actingSellerId(req.user), id, false, req.user.role, req.user.storeId);
  }

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Patch('conversations/:id/pin')
  pinConversation(@Req() req: any, @Param('id') id: string, @Query('pin') pin: string) {
    return this.messagingService.pinConversation(actingSellerId(req.user), id, pin !== 'false', req.user.role, req.user.storeId);
  }

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Patch('conversations/:id/mute')
  muteConversation(@Req() req: any, @Param('id') id: string, @Query('mute') mute: string) {
    return this.messagingService.muteConversation(actingSellerId(req.user), id, mute !== 'false', req.user.role, req.user.storeId);
  }

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Delete('conversations/:id')
  deleteConversation(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.deleteConversationForSelf(actingSellerId(req.user), req.user.role, id, req.user.storeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGES  (nested under a conversation)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Post('conversations/:convId/messages')
  sendMessage(@Req() req: any, @Param('convId') convId: string, @Body() dto: SendMessageDto) {
    return this.messagingService.sendMessage(actingSellerId(req.user), req.user.role, convId, dto, req.user.storeId);
  }

  // Static sub-route BEFORE cursor-paginated list
  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(...STAFF_VIEW)
  @Get('conversations/:convId/messages/search')
  searchMessages(@Req() req: any, @Param('convId') convId: string, @Query('q') q: string) {
    return this.messagingService.searchMessages(actingSellerId(req.user), req.user.role, convId, q, req.user.storeId);
  }

  // Cursor-paginated message list: ?before=<messageId>&limit=30
  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(...STAFF_VIEW)
  @Get('conversations/:convId/messages')
  getMessages(@Req() req: any, @Param('convId') convId: string, @Query() query: any) {
    return this.messagingService.getMessages(actingSellerId(req.user), req.user.role, convId, query, req.user.storeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ATTACHMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Post('conversations/:convId/attachments')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  }))
  uploadAttachment(
    @Req() req: any,
    @Param('convId') convId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.messagingService.uploadAttachment(actingSellerId(req.user), req.user.role, convId, file, req.user.storeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE OPERATIONS  (by message ID)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Patch('messages/:id')
  editMessage(@Req() req: any, @Param('id') id: string, @Body() dto: EditMessageDto) {
    return this.messagingService.editMessage(actingSellerId(req.user), id, dto, req.user.role, req.user.storeId);
  }

  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(STAFF_MANAGE)
  @Delete('messages/:id')
  deleteMessage(@Req() req: any, @Param('id') id: string) {
    return this.messagingService.deleteMessageForSelf(actingSellerId(req.user), id, req.user.role, req.user.storeId);
  }

  // Mark messages as seen up to this message ID
  @UseGuards(RolesGuard, PermissionsGuard)
  @Roles('user', 'seller', 'staff')
  @RequirePermission(...STAFF_VIEW)
  @Post('messages/:id/seen')
  markSeen(@Req() req: any, @Param('id') id: string, @Query('conversationId') conversationId: string) {
    return this.messagingService.markSeen(actingSellerId(req.user), req.user.role, conversationId, id, req.user.storeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODERATION
  // ═══════════════════════════════════════════════════════════════════════════

  // Block/report/unblock deliberately NOT opened to 'staff' — a global,
  // cross-store identity block/moderation action on behalf of the seller
  // is a bigger, account-wide decision than a single store-scoped staff
  // login should be able to make unilaterally. Explicitly locked to
  // 'user'/'seller' (previously had no `@Roles` at all, so a staff JWT —
  // which has no real `userId` claim of its own — could technically have
  // reached these; closed off explicitly rather than left ambiguous).
  @UseGuards(RolesGuard)
  @Roles('user', 'seller')
  @Post('block')
  blockUser(@Req() req: any, @Body() dto: BlockDto) {
    return this.messagingService.blockUser(req.user.userId, req.user.role, dto);
  }

  @UseGuards(RolesGuard)
  @Roles('user', 'seller')
  @Delete('block/:targetId')
  unblockUser(@Req() req: any, @Param('targetId') targetId: string) {
    return this.messagingService.unblockUser(req.user.userId, targetId);
  }

  @UseGuards(RolesGuard)
  @Roles('user', 'seller')
  @Post('report')
  reportTarget(@Req() req: any, @Body() dto: ReportDto) {
    return this.messagingService.reportTarget(req.user.userId, req.user.role, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN  (static routes before parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('admin/conversations')
  adminGetConversations(@Query() query: any) {
    return this.messagingService.adminGetConversations(query);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('admin/reports')
  adminGetReports(@Query() query: any) {
    return this.messagingService.adminGetReports(query);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('admin/conversations/:id')
  adminGetConversation(@Param('id') id: string) {
    return this.messagingService.adminGetConversation(id);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Patch('admin/reports/:id/resolve')
  adminResolveReport(@Req() req: any, @Param('id') id: string, @Body() dto: { resolution?: 'approved' | 'removed'; adminNotes?: string }) {
    return this.messagingService.adminResolveReport(req.user.userId, id, dto);
  }
}
