// import {
//     Controller,
//     Post,
//     Body,
//     HttpCode,
//     HttpStatus,
//     Req,
//     Get,
// } from '@nestjs/common';
// import {
//     ApiTags,
//     ApiOperation,
//     ApiResponse,
// } from '@nestjs/swagger';
// import { OtpService } from './otp.service';
// import { SendOtpDto, VerifyOtpDto, ResendOtpDto } from './dto/otp.dto';
// import type { Request } from 'express';

// @ApiTags('OTP')
// @Controller('api/otp')
// export class OtpController {
//     constructor(private readonly otpService: OtpService) { }

//     // Send OTP
//     @Post('send')
//     @HttpCode(HttpStatus.OK)
//     @ApiOperation({ summary: 'Send OTP to email' })
//     @ApiResponse({ status: 200, description: 'OTP sent successfully' })
//     @ApiResponse({ status: 400, description: 'Too many requests or invalid data' })
//     sendOtp(@Body() sendOtpDto: SendOtpDto, @Req() req: Request) {
//         const ipAddress = req.ip;
//         const userAgent = req.get('user-agent');
//         return this.otpService.sendOtp(sendOtpDto, ipAddress, userAgent);
//     }

//     // Verify OTP
//     @Post('verify')
//     @HttpCode(HttpStatus.OK)
//     @ApiOperation({ summary: 'Verify OTP' })
//     @ApiResponse({ status: 200, description: 'OTP verified successfully' })
//     @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
//     @ApiResponse({ status: 401, description: 'Incorrect OTP' })
//     @ApiResponse({ status: 404, description: 'OTP not found' })
//     verifyOtp(@Body() verifyOtpDto: VerifyOtpDto) {
//         return this.otpService.verifyOtp(verifyOtpDto);
//     }

//     // Resend OTP
//     @Post('resend')
//     @HttpCode(HttpStatus.OK)
//     @ApiOperation({ summary: 'Resend OTP' })
//     @ApiResponse({ status: 200, description: 'OTP resent successfully' })
//     @ApiResponse({ status: 400, description: 'Please wait before requesting new OTP' })
//     resendOtp(@Body() resendOtpDto: ResendOtpDto, @Req() req: Request) {
//         const ipAddress = req.ip;
//         const userAgent = req.get('user-agent');
//         return this.otpService.resendOtp(resendOtpDto, ipAddress, userAgent);
//     }

//     // Get statistics (optional - admin only)
//     @Get('statistics')
//     @ApiOperation({ summary: 'Get OTP statistics' })
//     @ApiResponse({ status: 200, description: 'Statistics retrieved successfully' })
//     getStatistics() {
//         return this.otpService.getStatistics();
//     }
// }