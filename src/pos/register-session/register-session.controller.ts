/* eslint-disable prettier/prettier */
import { Controller, Post, Body } from '@nestjs/common';
import { RegisterSessionService } from './register-session.service';

@Controller('api/pos/session')
export class RegisterSessionController {
  constructor(private readonly registerSessionService: RegisterSessionService) {}

  @Post('open')
  async openSession(@Body() body: any) {
    return this.registerSessionService.openSession(body);
  }

  @Post('close')
  async closeSession(@Body() body: any) {
    return this.registerSessionService.closeSession(body);
  }
}
