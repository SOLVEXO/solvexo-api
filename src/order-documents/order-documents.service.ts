/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { UpdateOrderDocumentSettingsDto } from './dto/update-order-document-settings.dto';

const TEXT_FIELDS = [
  'companyName', 'addressText', 'phone', 'email', 'taxIdLabel', 'taxIdValue', 'watermarkText', 'slipMessage', 'slipFooter',
  'invoiceTitle', 'invoiceTerms', 'invoiceFooter', 'accentColor',
] as const;

/** Plain text only; control characters (except new lines in multi-line fields) are dropped. */
function cleanText(v: string): string {
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim();
}

/** What an untouched store prints: used when no settings doc exists and to fill any missing field. */
export const ORDER_DOCUMENT_DEFAULTS = {
  companyName: null, addressText: null, phone: null, email: null, taxIdLabel: null, taxIdValue: null,
  paperSize: 'a4', accentColor: null, showLogo: true, logoSize: 'medium', logoAlign: 'left',
  watermarkEnabled: false, watermarkType: 'logo', watermarkText: null, watermarkPosition: 'center', watermarkAngle: -30,
  watermarkOpacity: 8, watermarkSize: 'medium',
  slipShowPrices: false, slipShowSku: true, slipShowImages: true, slipShowNote: true, slipShowPayment: true, slipShowCheckbox: true,
  slipMessage: null, slipFooter: null,
  invoiceTitle: null, invoiceShowSku: true, invoiceShowImages: false, invoiceShowTaxId: true, invoiceTerms: null, invoiceFooter: null,
} as const;

/** Settings → Order documents: how the packing slip and the invoice look for one store. */
@Injectable()
export class OrderDocumentsService {
  constructor(private readonly db: DatabaseService) {}

  private get r() {
    return this.db.repositories;
  }

  private async load(storeId: string) {
    const doc: any = await this.r.orderDocumentSettingsModel.findOne({ storeId, isDelete: false }).lean();
    const settings: Record<string, unknown> = { ...ORDER_DOCUMENT_DEFAULTS };
    if (doc) for (const key of Object.keys(ORDER_DOCUMENT_DEFAULTS)) if (doc[key] !== undefined) settings[key] = doc[key];
    return settings;
  }

  /** Settings plus the store details a document falls back to (name, logo, contact email, currency). */
  async get(sellerId: string, storeId: string) {
    const store: any = await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    return {
      success: true,
      data: {
        settings: await this.load(storeId),
        store: {
          name: store.name ?? '',
          logo: store.logo ?? null,
          contactEmail: store.contactEmail ?? null,
          phone: store.phone ?? null,
          currency: store.baseCurrency ?? null,
        },
      },
    };
  }

  async update(sellerId: string, storeId: string, dto: UpdateOrderDocumentSettingsDto) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      if ((TEXT_FIELDS as readonly string[]).includes(key)) {
        const text = typeof value === 'string' ? cleanText(value) : '';
        set[key] = text === '' ? null : text;
      } else {
        set[key] = value;
      }
    }
    if (Object.keys(set).length > 0) {
      await this.r.orderDocumentSettingsModel.updateOne({ storeId }, { $set: { ...set, isDelete: false }, $setOnInsert: { storeId } }, { upsert: true });
    }
    return this.get(sellerId, storeId);
  }
}
