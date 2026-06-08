// import {
//     Controller,
//     Get,
//     Put,
//     Delete,
//     Body,
//     UseGuards,
// } from '@nestjs/common';
// import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
// import { UsersService } from './users.service';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { User } from '../auth/decorators/get-user.decorator'; // ✅ Import User decorator
// import { UpdateProfileDto } from './dto/update-profile.dto';
// import { ChangePasswordDto } from './dto/change-password.dto';

// @ApiTags('Users')
// @ApiBearerAuth()
// @Controller('api/users')
// @UseGuards(JwtAuthGuard)
// export class UsersController {
//     constructor(private readonly usersService: UsersService) { }

//     // GET /api/users/profile
//     @Get('profile')
//     @ApiOperation({ summary: 'Get user profile' })
//     @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
//     async getProfile(@User('_id') userId: string) {
//         const user = await this.usersService.getProfile(userId);

//         return {
//             success: true,
//             data: user,
//         };
//     }

//     // PUT /api/users/profile
//     @Put('profile')
//     @ApiOperation({ summary: 'Update user profile' })
//     @ApiResponse({ status: 200, description: 'Profile updated successfully' })
//     updateProfile(
//         @User('_id') userId: string,
//         @Body() dto: UpdateProfileDto,
//     ) {
//         return this.usersService.updateProfile(userId, dto);
//     }

//     // DELETE /api/users/profile
//     @Delete('profile')
//     @ApiOperation({ summary: 'Delete user account (soft delete)' })
//     @ApiResponse({ status: 200, description: 'Account deactivated successfully' })
//     deleteAccount(@User('_id') userId: string) {
//         return this.usersService.deleteAccount(userId);
//     }

//     // PUT /api/users/change-password
//     @Put('change-password')
//     @ApiOperation({ summary: 'Change user password' })
//     @ApiResponse({ status: 200, description: 'Password changed successfully' })
//     changePassword(
//         @User('_id') userId: string,
//         @Body() dto: ChangePasswordDto,
//     ) {
//         return this.usersService.changePassword(userId, dto);
//     }
// }