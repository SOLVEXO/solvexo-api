import { MemberTwoFactorService } from '../auth/member-two-factor.service';
import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Req,
  UseGuards,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService, private readonly memberTwoFactor: MemberTwoFactorService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  async getProfile(@Req() req: any) {
    const user = await this.usersService.getProfile(req.user.userId);
    return { success: true, data: user };
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.userId, dto);
  }

  @Delete('profile')
  @ApiOperation({ summary: 'Delete user account (soft delete)' })
  @ApiResponse({ status: 200, description: 'Account deactivated successfully' })
  deleteAccount(@Req() req: any) {
    return this.usersService.deleteAccount(req.user.userId, req.user.role);
  }

  @Put('change-password')
  @ApiOperation({ summary: 'Change user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto, @Headers('x-step-up') stepUp?: string) {
    // A seller with two-factor must have just proved it (x-step-up token) to change the password.
    if (req.user.role === 'seller') await this.memberTwoFactor.assertStepUp('seller', String(req.user.userId), stepUp);
    return this.usersService.changePassword(
      req.user.userId,
      req.user.role,
      dto,
      req.headers?.authorization?.split(' ')[1],
    );
  }
}
