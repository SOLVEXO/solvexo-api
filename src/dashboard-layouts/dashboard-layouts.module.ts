import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { DashboardLayout, DashboardLayoutSchema } from './dashboard-layout.schema';
import { AdminDashboardLayoutsController, StoreDashboardLayoutsController } from './dashboard-layouts.controller';
import { DashboardLayoutsService } from './dashboard-layouts.service';

@Module({
  imports: [AuthModule, RedisModule, MongooseModule.forFeature([{ name: DashboardLayout.name, schema: DashboardLayoutSchema }])],
  controllers: [StoreDashboardLayoutsController, AdminDashboardLayoutsController],
  providers: [DashboardLayoutsService],
})
export class DashboardLayoutsModule {}
