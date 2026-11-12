/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type JobLeaseDocument = JobLease & Document;

/**
 * One row per lease key (`_id` = the key, e.g. `payments:poll:<intentId>`). A lease is a time-limited claim: whoever holds an unexpired
 * lease is the only one allowed to run that job / touch that payment. Expiry is judged by the DATABASE clock (`$$NOW`), so servers whose
 * clocks differ cannot steal each other's lease. The TTL index below is only housekeeping (it removes long-dead rows); correctness never
 * depends on it (MongoDB's TTL monitor runs about once a minute).
 */
@Schema({ collection: 'job_leases', timestamps: false, _id: false })
export class JobLease {
  @Prop({ type: String, required: true }) _id: string;
  /** A fresh random token per acquisition — the holder's proof. A holder whose lease expired and was taken over cannot renew or release it. */
  @Prop({ type: String, required: true }) token: string;
  /** Which instance (host:pid), for diagnostics only. */
  @Prop({ type: String, required: true }) owner: string;
  /** Fencing counter: +1 on every acquisition. */
  @Prop({ type: Number, required: true, default: 0 }) epoch: number;
  @Prop({ type: Date, required: true }) expiresAt: Date;
  @Prop({ type: Date }) acquiredAt?: Date;
}
export const JobLeaseSchema = SchemaFactory.createForClass(JobLease);
JobLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600, name: 'ttl_housekeeping' });
