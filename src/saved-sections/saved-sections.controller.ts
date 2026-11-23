import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { BlockInputDto } from '../common/dto/block-input.dto';
import { SECTION_TYPES, SectionType } from '../common/schemas/section.schema';
import { SavedSectionsService } from './saved-sections.service';

export class CreateSavedSectionDto {
  @IsString() @MaxLength(60) name: string;
  @IsIn(SECTION_TYPES) type: SectionType;
  @IsObject() settings: Record<string, any>;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => BlockInputDto) blocks: BlockInputDto[];
  @IsOptional() @IsString() colorSchemeId?: string | null;
}

export class UpdateSavedSectionDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsIn(SECTION_TYPES) type?: SectionType;
  @IsOptional() @IsObject() settings?: Record<string, any>;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => BlockInputDto) blocks?: BlockInputDto[];
  @IsOptional() @IsString() colorSchemeId?: string | null;
}

/** The store's library of reusable ("global") sections, edited in the theme editor. */
@ApiTags('Saved sections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.themes.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/saved-sections')
export class SavedSectionsController {
  constructor(private readonly service: SavedSectionsService) {}

  @Get(':storeId')
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.list(storeId);
  }

  @Post(':storeId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateSavedSectionDto) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.create(storeId, dto);
  }

  @Patch(':storeId/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateSavedSectionDto) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.update(storeId, id, dto);
  }

  @Delete(':storeId/:id')
  async remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.service.assertStoreAccess(storeId, actingSellerId(req.user));
    return this.service.remove(storeId, id);
  }
}
