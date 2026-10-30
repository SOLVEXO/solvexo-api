/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsString } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { CoursesService } from './courses.service';

class QuizDto { @IsArray() answers: number[]; }
class EnrollDto { @IsString() @IsNotEmpty() customerId: string; }

@ApiTags('Courses (public)')
@Controller('api/courses/verify')
export class PublicCertificateController {
  constructor(private readonly svc: CoursesService) {}
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':id')
  verify(@Param('id') id: string) { return this.svc.verify(id); }
}

@ApiTags('Courses (learner)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@Controller('api/courses/me')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class LearnerCoursesController {
  constructor(private readonly svc: CoursesService) {}
  private sid = (req: any, q?: string) => resolveBuyerStoreScope(req.user.storeId, q);

  @Get() list(@Req() req: any, @Query('storeId') q: string) { return this.svc.listMine(this.sid(req, q), req.user.userId); }
  @Get(':courseId') outline(@Req() req: any, @Query('storeId') q: string, @Param('courseId') c: string) { return this.svc.outline(this.sid(req, q), req.user.userId, c); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':courseId/lessons/:lessonId/media')
  media(@Req() req: any, @Query('storeId') q: string, @Param('courseId') c: string, @Param('lessonId') l: string) { return this.svc.mediaUrl(this.sid(req, q), req.user.userId, c, l); }

  @Post(':courseId/lessons/:lessonId/complete')
  complete(@Req() req: any, @Query('storeId') q: string, @Param('courseId') c: string, @Param('lessonId') l: string) { return this.svc.complete(this.sid(req, q), req.user.userId, c, l); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':courseId/lessons/:lessonId/quiz')
  quiz(@Req() req: any, @Query('storeId') q: string, @Param('courseId') c: string, @Param('lessonId') l: string, @Body() dto: QuizDto) { return this.svc.submitQuiz(this.sid(req, q), req.user.userId, c, l, dto.answers); }

  @Get(':courseId/certificate')
  async certificate(@Req() req: any, @Res() res: Response, @Query('storeId') q: string, @Param('courseId') c: string) {
    const { buffer, fileName } = await this.svc.certificate(this.sid(req, q), req.user.userId, c);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName}"`, 'Content-Length': buffer.length, 'Cache-Control': 'private, no-store' });
    res.end(buffer);
  }
}

@ApiTags('Courses (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('courses.manage')
@Controller('api/courses/store/:storeId')
export class SellerCoursesController {
  constructor(private readonly svc: CoursesService, private readonly db: DatabaseService) {}
  private own = (req: any, storeId: string) => verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));

  @Get() async list(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.list(s); }
  @Post() async create(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); return this.svc.create(s, b); }
  @Get(':id') async get(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.svc.get(s, id); }
  @Patch(':id') async update(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { await this.own(req, s); return this.svc.update(s, id, b); }
  @Get(':id/enrollments') async enrollments(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.svc.enrollments(s, id); }
  @Post(':id/enroll') async enroll(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() dto: EnrollDto) { await this.own(req, s); return this.svc.manualEnroll(s, id, dto.customerId, String(req.user.userId ?? req.user.staffId ?? 'seller')); }
}
