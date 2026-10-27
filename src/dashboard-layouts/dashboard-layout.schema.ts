import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DashboardLayoutDocument = HydratedDocument<DashboardLayout>;

/** One person's saved dashboard arrangement. `store` layouts are per (user, store); `admin` layouts are per admin
 *  (storeId is ''). The user id always comes from the JWT, never from the request. */
@Schema({ timestamps: true })
export class DashboardLayout {
  @Prop({ type: String, required: true, enum: ['store', 'admin'] })
  scope: string;

  @Prop({ type: String, required: true })
  ownerId: string;

  @Prop({ type: String, default: '' })
  storeId: string;

  @Prop({ type: String, default: null })
  preset: string | null;

  @Prop({ type: Number, default: 3 })
  columns: number;

  @Prop({ type: [{ _id: false, id: String, visible: Boolean, size: String, settings: { type: Object, default: {} } }], default: [] })
  widgets: { id: string; visible: boolean; size: string; settings: Record<string, string | number> }[];
}

export const DashboardLayoutSchema = SchemaFactory.createForClass(DashboardLayout);
DashboardLayoutSchema.index({ scope: 1, ownerId: 1, storeId: 1 }, { unique: true });
