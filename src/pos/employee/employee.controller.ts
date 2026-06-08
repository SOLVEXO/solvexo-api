/* eslint-disable prettier/prettier */
import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { EmployeeService } from './employee.service';

@Controller('api/pos')
export class EmployeeController {
  constructor(private readonly employeeService: EmployeeService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('register')
  async addRegister(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.employeeService.addRegister(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('shift')
  async addShift(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.employeeService.addShift(sellerId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('employee')
  async addEmployee(@Req() req: any, @Body() body: any) {
    const { userId: sellerId } = req.user;
    return this.employeeService.addEmployee(sellerId, body);
  }

  @Post('login')
  async posLogin(@Body() body: any) {
    return this.employeeService.posLogin(body);
  }
}
