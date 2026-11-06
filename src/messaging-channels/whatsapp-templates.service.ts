/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { Model, Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { decryptCredential } from '../common/credential-encryption.util';
import { WhatsAppCloudProvider } from '../integrations/providers/whatsapp-cloud.provider';
import { WhatsAppTemplate, WhatsAppTemplateDocument } from './messaging.schema';
import { templateParamCount, validateTemplateInput } from './messaging-rules.util';

export interface WhatsAppAccess { accessToken: string; phoneNumberId: string; wabaId: string }

/** Marketing message templates: the store's local copy, synced from and submitted to Meta (the provider call is the only network part). */
@Injectable()
export class WhatsAppTemplatesService {
  constructor(
    @InjectModel(WhatsAppTemplate.name) private readonly model: Model<WhatsAppTemplateDocument>,
    private readonly db: DatabaseService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private provider() { return this.moduleRef.get(WhatsAppCloudProvider, { strict: false }); }

  /** The store's connected WhatsApp Business account (token decrypted), or a clear error. */
  async access(storeId: string): Promise<WhatsAppAccess> {
    const integration: any = await this.db.repositories.storeIntegrationModel.findOne({ storeId, type: 'whatsapp', provider: 'whatsapp_cloud', status: 'connected' });
    if (!integration?.credentialsEncrypted || !integration.config?.phoneNumberId || !integration.config?.wabaId) throw new BadRequestException('Connect your WhatsApp Business account first (Integrations).');
    let accessToken: string;
    try { accessToken = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).accessToken; }
    catch { throw new BadRequestException('Your WhatsApp connection needs to be reconnected.'); }
    return { accessToken, phoneNumberId: integration.config.phoneNumberId, wabaId: integration.config.wabaId };
  }

  list(storeId: string) { return this.model.find({ storeId }).sort({ updatedAt: -1 }).limit(500).lean(); }

  async get(storeId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Template not found');
    const t = await this.model.findOne({ _id: id, storeId }).lean();
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  /** Refreshes the status of every template from Meta (and records templates created in Meta's own manager). */
  async sync(storeId: string) {
    const a = await this.access(storeId);
    const r = await this.provider().listTemplates(a.accessToken, a.wabaId);
    if (!r.ok) throw new BadRequestException(`Could not load your templates from WhatsApp: ${r.error ?? 'unknown error'}`);
    const now = new Date();
    for (const t of r.templates) {
      await this.model.updateOne(
        { storeId, name: t.name, language: t.language },
        { $set: { category: String(t.category ?? '').toUpperCase(), status: String(t.status ?? '').toUpperCase(), bodyText: t.bodyText ?? '', paramCount: templateParamCount(t.bodyText ?? ''), metaId: t.id ?? null, rejectedReason: t.rejectedReason ?? null, lastSyncedAt: now } },
        { upsert: true },
      );
    }
    return { synced: r.templates.length };
  }

  /** Writes a marketing template and submits it to Meta for review. It cannot be used in a campaign until Meta approves it. */
  async submit(storeId: string, input: { name?: string; language?: string; bodyText?: string; examples?: string[] }) {
    const t = { name: String(input?.name ?? '').trim(), language: String(input?.language ?? '').trim(), bodyText: String(input?.bodyText ?? '').trim(), examples: Array.isArray(input?.examples) ? input.examples.map(String) : [] };
    const err = validateTemplateInput(t);
    if (err) throw new BadRequestException(err);
    if (await this.model.exists({ storeId, name: t.name, language: t.language })) throw new ConflictException('A template with this name and language already exists');
    const a = await this.access(storeId);
    const r = await this.provider().createTemplate(a.accessToken, a.wabaId, { ...t, category: 'MARKETING' });
    if (!r.ok) throw new BadRequestException(`WhatsApp did not accept the template: ${r.error ?? 'unknown error'}`);
    const doc = await this.model.create({ storeId, name: t.name, language: t.language, category: 'MARKETING', status: String(r.status ?? 'PENDING').toUpperCase(), bodyText: t.bodyText, paramCount: templateParamCount(t.bodyText), metaId: r.id ?? null, lastSyncedAt: new Date() });
    return doc.toObject();
  }

  async remove(storeId: string, id: string) {
    const t: any = await this.get(storeId, id);
    const a = await this.access(storeId);
    const r = await this.provider().deleteTemplate(a.accessToken, a.wabaId, t.name);
    if (!r.ok) throw new BadRequestException(`WhatsApp could not delete the template: ${r.error ?? 'unknown error'}`);
    await this.model.deleteMany({ storeId, name: t.name });
    return { success: true };
  }
}
