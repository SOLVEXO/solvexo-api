/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SavedReportDocument = HydratedDocument<SavedReport>;

/** Real "saved custom report" — Shopify's actual "Reports" permission, the
 *  Tier-2 audit's disclosed gap (export already existed, nothing let a
 *  seller SAVE a filter configuration to re-run later instead of
 *  reconfiguring the AnalyticsFilterBar from scratch every time). A saved
 *  report is just a named, persisted instance of the same filter shape
 *  `ExportQueryDto`/`AnalyticsQueryDto` already validate — running one is
 *  the exact same `GET .../export` call with `config` spread back in, no
 *  separate report-execution engine. */
@Schema({ timestamps: true })
export class SavedReport {
  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({
    type: {
      range: { type: String, default: '30d' },
      from: { type: String, default: null },
      to: { type: String, default: null },
      compareToPreviousPeriod: { type: Boolean, default: false },
      format: { type: String, default: 'csv' },
      section: { type: String, default: null },
    },
    required: true,
    _id: false,
  })
  config: {
    range: string;
    from: string | null;
    to: string | null;
    compareToPreviousPeriod: boolean;
    format: string;
    section: string | null;
  };

  createdAt?: Date;
  updatedAt?: Date;
}

export const SavedReportSchema = SchemaFactory.createForClass(SavedReport);
SavedReportSchema.index({ storeId: 1, createdAt: -1 });
