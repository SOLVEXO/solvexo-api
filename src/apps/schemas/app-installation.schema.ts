/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AppInstallationDocument = HydratedDocument<AppInstallation>;

/**
 * Phase 8 — real, per-store install state for an app in `app-catalog.ts`.
 * This is the tenant-isolation boundary the whole feature depends on: a
 * block whose type is `app:<appId>:<key>` is only ever allowed into a
 * store's sections if THAT store has a real row here for `appId` — see
 * `AppsService.assertBlocksAllowed`. `appId` is validated against the
 * real catalog at the service layer (not enum-locked here, same
 * "loosely typed at the schema, strictly checked at the service" pattern
 * `Block.type` itself already uses) so a new catalog entry never needs a
 * schema migration.
 */
@Schema({ timestamps: true })
export class AppInstallation {
  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true })
  appId: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const AppInstallationSchema = SchemaFactory.createForClass(AppInstallation);

AppInstallationSchema.index({ storeId: 1, appId: 1 }, { unique: true });
