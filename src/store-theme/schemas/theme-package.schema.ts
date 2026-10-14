import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ThemePackageDocument = HydratedDocument<ThemePackage>;

@Schema({ _id: false })
export class ThemePackageFile {
  @Prop({ required: true }) path: string;
  @Prop({ required: true, enum: ['utf8', 'base64'] }) encoding: 'utf8' | 'base64';
  /** Binary assets live in ThemePackageAsset (keyed by sha256) so a revision stays far below Mongo's 16 MiB document limit; `content` is '' for them. */
  @Prop({ default: '' }) content: string;
  @Prop({ type: Boolean, default: false }) external: boolean;
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
  /** Result of the import-time compatibility check (which pages render, notes about unsupported features). */
  @Prop({ type: Object, default: null }) compatibility: Record<string, any> | null;
  createdAt?: Date;
}

export const ThemePackageSchema = SchemaFactory.createForClass(ThemePackage);

/** Binary theme asset (image/font/…) stored once per store and shared by every revision that contains it. */
@Schema({ timestamps: true })
export class ThemePackageAsset {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) sha256: string;
  @Prop({ required: true }) content: string; // base64
  @Prop({ required: true }) size: number;
}
export type ThemePackageAssetDocument = HydratedDocument<ThemePackageAsset>;
export const ThemePackageAssetSchema = SchemaFactory.createForClass(ThemePackageAsset);
ThemePackageAssetSchema.index({ storeId: 1, sha256: 1 }, { unique: true });
ThemePackageSchema.index({ storeId: 1, installedThemeId: 1, version: -1 }, { unique: true });

/** One background ZIP import. The upload returns immediately; the dialog polls this document. */
@Schema({ timestamps: true })
export class ThemeImportJob {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) installedThemeId: string;
  @Prop({ required: true }) createdBy: string;
  @Prop({ type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' }) status: 'processing' | 'ready' | 'failed';
  @Prop({ type: String, default: 'reading' }) stage: string;
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ type: Number, default: null }) version: number | null;
  @Prop({ type: String, default: '' }) fileName: string;
  createdAt?: Date;
  updatedAt?: Date;
}
export type ThemeImportJobDocument = HydratedDocument<ThemeImportJob>;
export const ThemeImportJobSchema = SchemaFactory.createForClass(ThemeImportJob);
ThemeImportJobSchema.index({ storeId: 1, installedThemeId: 1, createdAt: -1 });
ThemeImportJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
