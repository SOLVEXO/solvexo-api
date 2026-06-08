/* eslint-disable prettier/prettier */
import { Body, Controller, Post, Req, Get } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard'; ;





@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ✅ Signup
 
  @Post('register')
  async signup( @Body() RegisterDto: RegisterDto) {
    return this.authService.signup(RegisterDto);
  }

  // ✅ Login
  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  
   @Post('resend-otp') 
  async resendOtp(@Body() body: { email: string; role: string }) {
    const { email, role } = body;
    return this.authService.resendOtp(email, role);
  }

    @Post('verifyOtp') 
  async verifyOtp(@Body() body: { email: string; role: string, otp: string }) {
    const { email, role, otp } = body;
    return this.authService.verifyOtp(email, role, otp);
  }

   @Post('forgot-password')
  async forgotPassword(
    @Body('email') email: string,
    @Body('role') role: string,
  ) {
    return this.authService.forgotPassword(email, role);
  }

  
  @Post('reset-password')
  async resetPassword(
  @Body('email') email: string,
  @Body('role') role: string,
  @Body('otp') otp: string,
  @Body('newPassword') newPassword: string,
) {
  return this.authService.resetPassword(email, role, otp, newPassword);
}

  @UseGuards(JwtAuthGuard)
@Get('getprofile')
async getProfile( @Req() req: any  ) {
    const {userId , role} = req.user
    console.log(userId, role)
  return this.authService.getProfile(userId, role);
}



}