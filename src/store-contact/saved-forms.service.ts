/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateContactFormSettings } from './contact-form-fields.util';
import { SavedForm, SavedFormDocument } from './schemas/saved-form.schema';

export const MAX_SAVED_FORMS = 25;

/** Only these settings travel with a saved form (never a section's id, heading or design). */
const KEPT = ['intro', 'buttonLabel', 'successMessage', 'fields', 'formName', 'successAction', 'redirectUrl', 'display', 'popupButtonLabel', 'notifyEmails', 'autoReplyEnabled', 'autoReplySubject', 'autoReplyBody', 'captcha'] as const;

/** The seller's library of saved forms: save a form once, drop it on any page. */
@Injectable()
export class SavedFormsService {
  constructor(
    private readonly databaseService: DatabaseService,
    @InjectModel(SavedForm.name) private readonly model: Model<SavedFormDocument>,
  ) {}

  private get storeModel() { return this.databaseService.repositories.storeModel; }

  async list(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const rows = await this.model.find({ storeId }).sort({ name: 1 }).lean();
    return { success: true, data: rows.map(r => ({ _id: String(r._id), name: r.name, settings: r.settings, updatedAt: (r as any).updatedAt })) };
  }

  async create(storeId: string, sellerId: string, name: unknown, settings: unknown) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 60) throw new BadRequestException('Give the form a name (up to 60 characters)');
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new BadRequestException('There is no form to save');
    const clean: Record<string, unknown> = {};
    for (const k of KEPT) if ((settings as Record<string, unknown>)[k] !== undefined) clean[k] = (settings as Record<string, unknown>)[k];
    validateContactFormSettings(clean);
    if (await this.model.countDocuments({ storeId }) >= MAX_SAVED_FORMS) throw new BadRequestException(`You can keep up to ${MAX_SAVED_FORMS} saved forms. Delete one first.`);
    try {
      const row = await this.model.create({ storeId, name: label, settings: clean });
      return { success: true, data: { _id: String(row._id), name: row.name, settings: row.settings } };
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('A saved form with this name already exists');
      throw err;
    }
  }

  async remove(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new NotFoundException('Saved form not found');
    const res = await this.model.deleteOne({ _id: id, storeId });
    if (!res.deletedCount) throw new NotFoundException('Saved form not found');
    return { success: true };
  }
}
