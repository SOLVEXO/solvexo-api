/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { KybAuditEvent, KybAuditEventDocument } from './kyb.schemas';

export interface KybActor { type: 'owner' | 'admin' | 'system'; id?: string | null; ip?: string | null; userAgent?: string | null }

/** The audit writer. `record` is AWAITED by every caller; for document views/downloads and decrypted reads a failed write aborts the access (fail closed). */
@Injectable()
export class KybAuditService {
  constructor(@InjectModel(KybAuditEvent.name) readonly model: Model<KybAuditEventDocument>) {}

  async record(storeId: string, actor: KybActor, action: string, meta?: Record<string, unknown> | null, target?: { type: string; id: string }): Promise<void> {
    await this.model.create([{
      storeId, actorType: actor.type, actorId: actor.id ?? null, action, targetType: target?.type ?? null, targetId: target?.id ?? null,
      meta: meta ?? null, ip: actor.ip ?? null, userAgent: actor.userAgent?.slice(0, 200) ?? null,
    }]);
  }

  async list(storeId: string, q: { page?: number; limit?: number; action?: string }) {
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const filter: any = { storeId }; if (q.action) filter.action = q.action;
    const [items, total] = await Promise.all([this.model.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.model.countDocuments(filter)]);
    return { items, page, limit, total, pages: Math.ceil(total / limit) };
  }
}
