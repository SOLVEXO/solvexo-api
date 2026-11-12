/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Post, Put, Request, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ComplianceActor, PlatformComplianceService } from './platform-compliance.service';

class ResearchDto { @IsString() @MaxLength(300) source: string; @IsOptional() @IsString() @MaxLength(500) note?: string }
class VerifyRulesDto { @IsString() @MaxLength(300) source: string; @IsString() @MaxLength(120) accountantName: string; @IsOptional() @IsString() @MaxLength(500) note?: string }
class RuleDto {
  @IsString() @Matches(/^[A-Za-z]{2}$/, { message: 'country must be a 2-letter ISO code' }) country: string;
  @IsOptional() @IsString() @MaxLength(40) supplyType?: string;
  @IsIn(['taxable', 'zero_rated', 'exempt', 'out_of_scope', 'unknown']) treatment: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) ratePercent?: number | null;
  @IsString() @MaxLength(300) source: string;
  @IsString() @MaxLength(120) accountantName: string;
}
class ApproveLiveDto { @IsString() @MaxLength(40) confirmation: string }
class RevokeDto { @IsOptional() @IsString() @MaxLength(500) note?: string }

const actor = (req: any): ComplianceActor => ({ userId: req.user.userId, teamAdmin: req.user.teamAdmin === true, name: req.user.email });

/**
 * Compliance states of Solvexo's OWN tax registration. Everyone with billing access can read; only the Super Admin can move a state
 * up (a team admin gets 403 from the service even when the role has billing.manage).
 */
@ApiTags('Admin Tax Compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@Controller('api/admin/tax-compliance')
export class PlatformComplianceController {
  constructor(private readonly service: PlatformComplianceService) {}

  @RequirePermission('billing.manage') @Get()
  async get() { return { success: true, data: await this.service.getState() }; }

  @RequirePermission('billing.manage') @Post('research')
  async research(@Body() dto: ResearchDto, @Request() req: any) { return { success: true, data: await this.service.markResearched(actor(req), dto) }; }

  @RequirePermission('billing.manage') @Put('rules')
  async rule(@Body() dto: RuleDto, @Request() req: any) { return { success: true, data: await this.service.upsertRule(actor(req), dto) }; }

  @RequirePermission('billing.manage') @Post('verify-rules')
  async verify(@Body() dto: VerifyRulesDto, @Request() req: any) { return { success: true, data: await this.service.verifyRules(actor(req), dto) }; }

  @RequirePermission('billing.manage') @Post('approve-live')
  async approve(@Body() dto: ApproveLiveDto, @Request() req: any) { return { success: true, data: await this.service.approveLive(actor(req), dto) }; }

  @RequirePermission('billing.manage') @Post('revoke-live')
  async revoke(@Body() dto: RevokeDto, @Request() req: any) { return { success: true, data: await this.service.revokeLive(actor(req), dto) }; }
}
