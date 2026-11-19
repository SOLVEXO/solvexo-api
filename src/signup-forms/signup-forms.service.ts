/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { pickFields } from '../common/pick-fields.util';
import { NewsletterService } from '../newsletter/newsletter.service';
import { UpdateSignupFormDto } from './dto/signup-form.dto';

const UPDATABLE = ['enabled', 'heading', 'body', 'buttonLabel', 'successHeading', 'successMessage', 'showAfterPageViews', 'delaySeconds', 'exitIntent', 'teaser', 'teaserText'] as const;

/** What the storefront needs to show the popup — never the counters. */
function publicShape(f: any) {
  return {
    heading: f.heading, body: f.body, buttonLabel: f.buttonLabel, successHeading: f.successHeading, successMessage: f.successMessage,
    showAfterPageViews: f.showAfterPageViews, delaySeconds: f.delaySeconds, exitIntent: f.exitIntent, teaser: f.teaser, teaserText: f.teaserText,
  };
}

@Injectable()
export class SignupFormsService {
  constructor(private readonly databaseService: DatabaseService, private readonly newsletter: NewsletterService) {}

  private get r() { return this.databaseService.repositories; }

  private async owned(sellerId: string, storeId: string) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid store');
    return verifyStoreOwnershipOrForbidden(this.r.storeModel as any, storeId, sellerId);
  }

  private async getOrCreate(storeId: string) {
    return this.r.signupFormModel.findOneAndUpdate({ storeId }, { $setOnInsert: { storeId } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
  }

  async getForSeller(sellerId: string, storeId: string) {
    await this.owned(sellerId, storeId);
    return { success: true, data: await this.getOrCreate(storeId) };
  }

  async update(sellerId: string, storeId: string, dto: UpdateSignupFormDto) {
    await this.owned(sellerId, storeId);
    const changes: Record<string, any> = pickFields(dto, UPDATABLE);
    for (const k of ['heading', 'buttonLabel', 'successHeading'] as const) if (typeof changes[k] === 'string') changes[k] = changes[k].trim();
    if ('discountCode' in dto) {
      const raw = typeof dto.discountCode === 'string' ? dto.discountCode.trim().toUpperCase() : '';
      if (!raw) changes.discountCode = null;
      else {
        // Only a real, live code of THIS store may be shown — a typo is never put in front of shoppers.
        const exists = await this.r.couponModel.exists({ storeId, code: raw, scope: 'seller', isActive: true, isDelete: false });
        if (!exists) throw new BadRequestException(`"${raw}" is not an active discount code in this store. Create it under Discounts first.`);
        changes.discountCode = raw;
      }
    }
    const updated = await this.r.signupFormModel.findOneAndUpdate({ storeId }, { $set: changes, $setOnInsert: { storeId } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
    return { success: true, message: 'Signup form saved', data: updated };
  }

  /** Storefront: the popup's settings, or nothing when it is off (or the store is not live). */
  async getPublic(storeId: string) {
    if (!isValidObjectId(storeId)) return { success: true, data: null };
    const form: any = await this.r.signupFormModel.findOne({ storeId, enabled: true }).lean();
    if (!form) return { success: true, data: null };
    const store = await this.r.storeModel.exists({ _id: storeId, isDelete: false, status: 'active' });
    return { success: true, data: store ? publicShape(form) : null };
  }

  async recordView(storeId: string) {
    if (!isValidObjectId(storeId)) return { success: true };
    await this.r.signupFormModel.updateOne({ storeId, enabled: true }, { $inc: { views: 1 } });
    return { success: true };
  }

  /** Storefront: the visitor typed their email in the popup. Subscribes them to the store's list (double opt-in applies if the store uses it). */
  async submit(storeId: string, email: string) {
    if (!isValidObjectId(storeId)) throw new NotFoundException('Form not found');
    const form: any = await this.r.signupFormModel.findOne({ storeId, enabled: true }).lean();
    if (!form) throw new NotFoundException('This form is not available');
    const res: any = await this.newsletter.subscribe(email, { storeId, source: 'store_popup' });
    await this.r.signupFormModel.updateOne({ storeId }, { $inc: { submissions: 1 } });
    return { success: true, message: res?.message, data: { pendingConfirmation: !!res?.data?.pendingConfirmation, discountCode: form.discountCode ?? null } };
  }
}
