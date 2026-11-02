/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { LEAD_SOURCES, LEAD_STAGES, LOST_REASONS } from './sales-ops.constants';

export class LeadDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(160)
  businessName?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(160)
  email?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  phone?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  city?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  country?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  businessType?: string | null;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  sourceDetail?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() ownerAdminId?:
    | string
    | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  dealValuePKR?: number | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
}

export class LeadListDto {
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) stage?: string;
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['overdue', 'today']) due?: 'overdue' | 'today';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

export class StageDto {
  @IsIn(LEAD_STAGES as unknown as string[]) stage: string;
  @IsOptional() @IsIn(LOST_REASONS as unknown as string[]) lostReason?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ActivityDto {
  @IsIn(['note', 'call', 'whatsapp', 'meeting']) type: string;
  @IsString() @MaxLength(5000) body: string;
  @IsOptional() @IsString() @MaxLength(80) outcome?: string;
}

export class EmailDto {
  @IsString() @MaxLength(200) subject: string;
  @IsString() @MaxLength(10000) body: string;
}

export class TaskDto {
  @IsString() @MaxLength(200) title: string;
  @IsDateString() dueAt: string;
  @IsOptional() @IsString() assigneeAdminId?: string;
}

export class TaskPatchDto {
  @IsOptional() @IsBoolean() done?: boolean;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsDateString() dueAt?: string;
}

export class TaskListDto {
  @IsOptional() @IsIn(['mine', 'all']) scope?: 'mine' | 'all';
  @IsOptional() @IsIn(['open', 'done']) status?: 'open' | 'done';
}

export class TemplateDto {
  @IsString() @MaxLength(80) name: string;
  @IsString() @MaxLength(200) subject: string;
  @IsString() @MaxLength(10000) body: string;
}

// ── Lead capture (phase 2) ─────────────────────────────────────────────────

const optStr = (max: number) => [
  IsOptional(),
  ValidateIf((_: unknown, v: unknown) => v !== null),
  IsString(),
  MaxLength(max),
];
function OptStr(max: number): PropertyDecorator {
  return (target, key) => optStr(max).forEach((d) => d(target, key));
}

/** The public Book-a-demo form. `website` is a honeypot: people never see it, bots fill it. */
export class DemoRequestDto {
  @IsString() @MaxLength(120) name: string;
  @IsString() @MaxLength(40) phone: string;
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsEmail()
  @MaxLength(160)
  email?: string | null;
  @OptStr(160) businessName?: string | null;
  @OptStr(80) city?: string | null;
  @OptStr(80) businessType?: string | null;
  @OptStr(2000) message?: string | null;
  @OptStr(40) preferredTime?: string | null;
  @OptStr(100) utmSource?: string | null;
  @OptStr(100) utmMedium?: string | null;
  @OptStr(100) utmCampaign?: string | null;
  @OptStr(200) page?: string | null;
  @OptStr(200) website?: string | null;
}

export class ImportRowDto {
  @OptStr(120) name?: string;
  @OptStr(160) email?: string;
  @OptStr(40) phone?: string;
  @OptStr(160) businessName?: string;
  @OptStr(80) city?: string;
  @OptStr(80) businessType?: string;
  @IsOptional() dealValuePKR?: number | string | null;
  @OptStr(2000) note?: string;
}

export class ImportDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows: ImportRowDto[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() ownerAdminId?:
    | string
    | null;
  @OptStr(200) sourceDetail?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

// ── Campaigns & team (phase 3) ─────────────────────────────────────────────

export class CampaignDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @IsOptional() @IsString() @MaxLength(30) channel?: string;
  @OptStr(60) utmSource?: string | null;
  @OptStr(60) utmMedium?: string | null;
  @IsOptional() @IsString() @MaxLength(200) landingPath?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() startDate?:
    | string
    | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() endDate?:
    | string
    | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  budgetPKR?: number | null;
  @OptStr(2000) notes?: string | null;
  @IsOptional() @IsBoolean() isArchived?: boolean;
}

export class SpendDto {
  @IsDateString() date: string;
  @Type(() => Number) @IsNumber() @Min(1) amountPKR: number;
  @OptStr(200) note?: string | null;
}

export class TargetRowDto {
  @IsString() adminId: string;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  wonDeals?: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  wonValuePKR?: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  activities?: number | null;
}

export class TargetsDto {
  @IsString() @MaxLength(7) month: string;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => TargetRowDto)
  targets: TargetRowDto[];
}

export class SalesSettingsDto {
  @IsBoolean() autoAssign: boolean;
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) assigneeIds: string[];
}
