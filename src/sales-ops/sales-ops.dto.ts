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
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { LEAD_SOURCES, LEAD_STAGES, LOST_REASONS } from './sales-ops.constants';
import { type VisitOptionGroup, optionKeys } from './field-visit.constants';
import { CONSENT_STATUSES } from './sales-brevo.util';

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
  /** Set by hand: true needs `marketingConsentNote` (where/when they agreed); false withdraws a granted consent. */
  @IsOptional() @IsBoolean() marketingConsent?: boolean;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  marketingConsentNote?: string | null;
}

export class LeadListDto {
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) stage?: string;
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['overdue', 'today']) due?: 'overdue' | 'today';
  @IsOptional() @IsIn(CONSENT_STATUSES as unknown as string[]) consent?:
    | 'none'
    | 'asked'
    | 'granted'
    | 'withdrawn';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

// ── Brevo (marketing email) ─────────────────────────────────────────────────

export class BrevoConnectDto {
  @IsString() @MaxLength(500) apiKey: string;
}

/** Either the ticked leads (`leadIds`) or, without them, every lead the list's filters match (same fields as the list). */
export class ConsentRequestsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  leadIds?: string[];
  @IsOptional() @IsIn(LEAD_STAGES as unknown as string[]) stage?: string;
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['overdue', 'today']) due?: 'overdue' | 'today';
  @IsOptional() @IsIn(CONSENT_STATUSES as unknown as string[]) consent?: 'none' | 'asked' | 'granted' | 'withdrawn';
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
  @OptStr(40) partnerCode?: string | null;
  /** "Send me tips and offers by email" (unticked = no change). */
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
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
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  visits?: number | null;
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

// ── Partners & commissions (phase 4) ───────────────────────────────────────

export class TierDto {
  @Type(() => Number) @IsInt() @Min(1) minPaying: number;
  @Type(() => Number) @IsNumber() @Min(0) percent: number;
}

export class CommissionPlanDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @OptStr(500) description?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  bountyPKR?: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  percent?: number | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  percentMonths?: number | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TierDto)
  tiers?: TierDto[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) holdDays?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minPayoutPKR?: number;
  @IsOptional() @IsBoolean() isArchived?: boolean;
}

export class PartnerDto {
  /** B4.7: withholding tax on this partner's payouts, in % (null = the programme default). */
  @IsOptional() @IsNumber() @Min(0) @Max(50) whtPercent?: number | null;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(20) kind?: string;
  @IsOptional() @IsString() @MaxLength(40) code?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() adminId?:
    | string
    | null;
  @OptStr(160) email?: string | null;
  @OptStr(40) phone?: string | null;
  @OptStr(80) city?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() planId?:
    | string
    | null;
  @IsOptional() @IsString() @MaxLength(20) payoutMethod?: string;
  @OptStr(500) payoutDetails?: string | null;
  @IsOptional() @IsIn(['active', 'paused']) status?: 'active' | 'paused';
  @OptStr(2000) notes?: string | null;
}

export class ReferralDto {
  @OptStr(160) sellerEmail?: string;
  @OptStr(40) sellerId?: string;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  effectiveFrom?: string | null;
}

export class AdjustmentDto {
  @Type(() => Number) @IsInt() amountPKR: number;
  @IsString() @MaxLength(200) description: string;
}

export class PayoutDto {
  @IsOptional() @IsString() @MaxLength(20) method?: string;
  @OptStr(120) reference?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() paidAt?:
    | string
    | null;
  @OptStr(500) note?: string | null;
}

// ── AI sales agent ──────────────────────────────────────────────────────────

export class AgentSettingsDto {
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
  @IsOptional() @IsBoolean() aiFirstReply?: boolean;
  @IsOptional() @IsBoolean() aiChat?: boolean;
  @IsOptional() @IsBoolean() aiWhatsApp?: boolean;
  @IsOptional() @IsString() @MaxLength(40) aiAgentName?: string;
  @OptStr(300) aiGreeting?: string | null;
  @OptStr(8000) aiKnowledge?: string | null;
  @OptStr(2000) aiRules?: string | null;
  @OptStr(200) aiSignOff?: string | null;
  @OptStr(160) aiReplyTo?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) aiChatDailyLimit?: number;
}

export class ChatTurnDto {
  @IsIn(['visitor', 'agent']) role: 'visitor' | 'agent';
  @IsString() @MaxLength(1500) text: string;
}

export class AgentPreviewDto {
  @IsString() @MaxLength(1000) message: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];
}

export class ChatStartDto {
  @OptStr(200) page?: string | null;
  @OptStr(100) utmSource?: string | null;
  @OptStr(100) utmMedium?: string | null;
  @OptStr(100) utmCampaign?: string | null;
  @OptStr(40) partnerCode?: string | null;
}

export class ChatMessageDto {
  @IsString() @MaxLength(1000) message: string;
}

export class DraftDto {
  @IsBoolean() sent: boolean;
}

// ── WhatsApp inbox ──────────────────────────────────────────────────────────

export class WaConnectDto {
  @IsString() @MaxLength(30) phoneNumberId: string;
  @OptStr(1000) accessToken?: string;
  @OptStr(100) templateName?: string | null;
  @IsOptional() @IsString() @MaxLength(10) templateLang?: string;
  @IsOptional() @IsBoolean() templateUsesName?: boolean;
  @OptStr(30) wabaId?: string | null;
}

export class WaSendDto {
  @IsString() @MaxLength(4000) text: string;
  @IsOptional() @IsBoolean() fromAiDraft?: boolean;
}

export class WaListDto {
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsIn(['true', 'false']) unread?: string;
}

// ── Field visits ───────────────────────────────────────────────────────────

const keysOf = (g: VisitOptionGroup) => optionKeys(g) as string[];
/** An optional single choice from one of the visit option groups (null clears it). */
const Choice = (g: VisitOptionGroup) => (target: object, key: string) => {
  IsOptional()(target, key);
  ValidateIf((_: unknown, v: unknown) => v !== null)(target, key);
  IsIn(keysOf(g))(target, key);
};
/** An optional multi-choice list from one of the visit option groups. */
const Choices = (g: VisitOptionGroup) => (target: object, key: string) => {
  IsOptional()(target, key);
  IsArray()(target, key);
  ArrayMaxSize(20)(target, key);
  IsIn(keysOf(g), { each: true })(target, key);
};
const ShortText = (max: number) => (target: object, key: string) => {
  IsOptional()(target, key);
  ValidateIf((_: unknown, v: unknown) => v !== null)(target, key);
  IsString()(target, key);
  MaxLength(max)(target, key);
};

export class VisitLocationDto {
  @Type(() => Number) @IsNumber() lat: number;
  @Type(() => Number) @IsNumber() lng: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsNumber() @Min(0) accuracyM?: number | null;
}

/** The answers of a visit; shared by "save" (VisitDto) and "correct" (VisitPatchDto). */
export class VisitAnswersDto {
  @ShortText(80) unit?: string | null;
  @Choice('floor') floor?: string | null;
  @ShortText(80) area?: string | null;
  @Choice('category') category?: string | null;
  @ShortText(80) categoryOther?: string | null;
  @Choice('priceRange') priceRange?: string | null;
  @Choice('wholesale') wholesale?: string | null;
  @ShortText(120) contactName?: string | null;
  @Choice('contactRole') contactRole?: string | null;
  @ShortText(30) whatsapp?: string | null;
  @IsOptional() @IsBoolean() waPermission?: boolean;
  @Choice('bestTime') bestTime?: string | null;
  @ShortText(120) instagram?: string | null;
  @ShortText(200) facebook?: string | null;
  @ShortText(200) website?: string | null;
  @Choices('sellsOn') sellsOn?: string[];
  @Choice('ordersPerMonth') ordersPerMonth?: string | null;
  @Choices('payments') payments?: string[];
  @Choices('couriers') couriers?: string[];
  @Choice('courierBooking') courierBooking?: string | null;
  @Choice('billing') billing?: string | null;
  @ShortText(80) billingSoftware?: string | null;
  @Choice('khata') khata?: string | null;
  @Choices('seasons') seasons?: string[];
  @ShortText(300) bestSellers?: string | null;
  @ShortText(1000) problem?: string | null;
  @Choices('problemTags') problemTags?: string[];
  @Choices('objections') objections?: string[];
}

export class VisitDto extends VisitAnswersDto {
  /** Made by the phone; a retry with the same id is stored once. */
  @IsString() @MaxLength(64) clientId: string;
  @IsString() @MaxLength(160) storeName: string;
  @IsIn(keysOf('interest')) interest: string;
  @IsIn(keysOf('nextStep')) nextStep: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() nextStepAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() visitedAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @ValidateNested() @Type(() => VisitLocationDto) location?: VisitLocationDto | null;
  /** The shop photo as a data URL (JPEG/PNG/WebP), already shrunk by the phone. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1_000_000) photoDataUrl?: string | null;
}

export class VisitPatchDto extends VisitAnswersDto {
  @IsOptional() @IsString() @MaxLength(160) storeName?: string;
  @IsOptional() @IsIn(keysOf('interest')) interest?: string;
  @IsOptional() @IsIn(keysOf('nextStep')) nextStep?: string;
}

export class VisitListDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @MaxLength(40) rep?: string;
  @IsOptional() @IsString() @MaxLength(80) area?: string;
  @IsOptional() @IsIn(keysOf('interest')) interest?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

export class VisitCheckDto {
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(160) storeName?: string;
  @IsOptional() @IsString() @MaxLength(80) area?: string;
}
