/* eslint-disable prettier/prettier */
import { PosSettings, PosSettingsSchema } from '../pos/schemas/pos-settings.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { UploadModule } from '@/upload/upload.module';
import { Store, StoreSchema } from '@/store/schemas/store.schema';
import { KybAuditEvent, KybAuditEventSchema, KybSettings, KybSettingsSchema, StoreKyb, StoreKybSchema } from './kyb.schemas';
import { KybAuditService } from './kyb-audit.service';
import { KybService } from './kyb.service';
import { KybAdminService } from './kyb-admin.service';
import { KybGateService } from './kyb-gate.service';
import { KybMaintenanceService } from './kyb-maintenance.service';
import { KybController } from './kyb.controller';
import { KybAdminController } from './kyb-admin.controller';

@Module({
  imports: [
    AuthModule, RedisModule, UploadModule,
    MongooseModule.forFeature([
      { name: StoreKyb.name, schema: StoreKybSchema },
      { name: KybAuditEvent.name, schema: KybAuditEventSchema },
      { name: KybSettings.name, schema: KybSettingsSchema },
      { name: Store.name, schema: StoreSchema },
      { name: PosSettings.name, schema: PosSettingsSchema }, // G5.4: the store's own Raast on / off switch
    ]),
  ],
  controllers: [KybController, KybAdminController],
  providers: [KybAuditService, KybService, KybAdminService, KybGateService, KybMaintenanceService],
  exports: [KybGateService, KybService],
})
export class KybModule {}
