/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Roles } from './decorators/roles.decorator';
import { RequirePermission } from './decorators/require-permission.decorator';
import { AuthVisualService } from '../common/auth-visual.service';

class BlockAuthVisualDto {
  /** Unsplash photo id, or the image URL as shown on the page. */
  @IsString() @MinLength(6) @MaxLength(500)
  photo: string;
}

@ApiTags('Admin Auth Visuals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/auth-visuals')
export class AdminAuthVisualController {
  constructor(private readonly authVisual: AuthVisualService) {}

  /** Never show this photo again on sign-up/login screens (also removed from stored pools). */
  @RequirePermission('config.manage')
  @Post('block')
  async block(@Body() dto: BlockAuthVisualDto) {
    try {
      return { success: true, data: await this.authVisual.blockPhoto(dto.photo) };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}
