/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { RegisterSessionController } from './register-session.controller';
import { RegisterSessionService } from './register-session.service';

@Module({
  controllers: [RegisterSessionController],
  providers: [RegisterSessionService],
})
export class RegisterSessionModule {}
