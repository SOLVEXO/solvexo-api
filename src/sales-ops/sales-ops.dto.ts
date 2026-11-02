/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
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
