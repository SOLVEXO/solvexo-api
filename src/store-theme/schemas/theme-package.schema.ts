import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ThemePackageDocument = HydratedDocument<ThemePackage>;

@Schema({ _id: false })
export class ThemePackageFile {
  @Prop({ required: true }) path: string;
  @Prop({ required: true, enum: ['utf8', 'base64'] }) encoding: 'utf8' | 'base64';
  @Prop({ required: true }) content: string;
  @Prop({ required: true }) size: number;
  @Prop({ required: true }) sha256: string;
}
export const ThemePackageFileSchema = SchemaFactory.createForClass(ThemePackageFile);

/** Immutable, validated source snapshot for one installed theme. A new
 * document is written for each upload/edit/rollback so rollback never mutates
 * an older version. Package content is deliberately capped below Mongo's
 * 16 MiB document ceiling by the importer. */
@Schema({ timestamps: true })
export class ThemePackage {
  @Prop({ required: true, index: true }) storeId: string;
  @Prop({ required: true, index: true }) installedThemeId: string;
  @Prop({ required: true }) version: number;
  @Prop({ required: true }) createdBy: string;
  @Prop({ type: String, enum: ['upload', 'file_edit', 'rollback'], required: true }) changeType: 'upload' | 'file_edit' | 'rollback';
  @Prop({ type: Number, default: null }) restoredFromVersion: number | null;
  @Prop({ type: [ThemePackageFileSchema], required: true }) files: ThemePackageFile[];
  createdAt?: Date;
}

export const ThemePackageSchema = SchemaFactory.createForClass(ThemePackage);
ThemePackageSchema.index({ storeId: 1, installedThemeId: 1, version: -1 }, { unique: true });
