/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { EmployeeController } from './employee.controller';
import { EmployeeService } from './employee.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';

@Module({
    imports: [AuthModule, RedisModule], 
  controllers: [EmployeeController],
  providers: [EmployeeService],
})
export class EmployeeModule {}
