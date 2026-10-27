/* eslint-disable prettier/prettier */
import type { CustomerEmailEvent } from './customer-email-events';

/**
 * Built-in customer-email text per language. English lives in the catalog (`customer-email-events.ts`); a language
 * here only needs the events it translates — anything missing falls back to the English default. The SAME tags as the
 * English default must be used (a spec checks it). A seller's own text always wins over these: see
 * `pickEmailText` in notifications.service.ts.
 */
export interface EmailUiStrings {
  viewOrder: string;
  viewGiftCard: string;
  trackPackage: string;
  customerFallback: string;
  rightsReserved: string;
  /** `{brand}` is replaced with the store name. */
  receivingBecause: string;
}

export const EMAIL_UI_STRINGS: Record<string, EmailUiStrings> = {
  en: {
    viewOrder: 'View your order',
    viewGiftCard: 'View your gift card',
    trackPackage: 'Track your package',
    customerFallback: 'there',
    rightsReserved: 'All rights reserved.',
    receivingBecause: "You're receiving this because of your order from {brand}. Reply to this email to contact the store.",
  },
  ur: {
    viewOrder: 'اپنا آرڈر دیکھیں',
    viewGiftCard: 'اپنا گفٹ کارڈ دیکھیں',
    trackPackage: 'اپنا پارسل ٹریک کریں',
    customerFallback: 'صارف',
    rightsReserved: 'جملہ حقوق محفوظ ہیں۔',
    receivingBecause: 'آپ کو یہ ای میل {brand} سے کیے گئے آپ کے آرڈر کی وجہ سے موصول ہوئی ہے۔ اسٹور سے رابطہ کرنے کے لیے اس ای میل کا جواب دیں۔',
  },
};

export const CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE: Record<string, Partial<Record<CustomerEmailEvent, { subject: string; body: string }>>> = {
  ur: {
    order_confirmation: {
      subject: '{{storeName}} سے آپ کا آرڈر تصدیق شدہ ہے',
      body: 'سلام {{customerName}}،\n\nآپ کے آرڈر کا شکریہ! {{storeName}} سے آرڈر {{orderNumber}} کی تصدیق ہو گئی ہے۔\n\n{{itemList}}\n\nذیلی کل: {{subtotal}}\nشپنگ: {{shipping}}\nٹیکس: {{tax}}\nکل رقم: {{total}}\n\nاس آرڈر کے بارے میں کوئی سوال ہو تو بس اس ای میل کا جواب دیں۔',
    },
    order_shipped: {
      subject: '{{storeName}} سے آپ کا آرڈر #{{orderNumber}} روانہ ہو گیا ہے',
      body: 'سلام {{customerName}}،\n\nخوشخبری! {{storeName}} سے آپ کا آرڈر #{{orderNumber}} راستے میں ہے۔\n\n{{itemList}}\n\nکوریئر: {{carrier}}\nٹریکنگ نمبر: {{trackingNumber}}',
    },
    order_ready_for_pickup: {
      subject: 'آپ کا آرڈر #{{orderNumber}} وصولی کے لیے تیار ہے — {{storeName}}',
      body: 'سلام {{customerName}}،\n\n{{storeName}} سے آپ کا آرڈر #{{orderNumber}} وصول کرنے کے لیے تیار ہے۔\n\nوصولی کی جگہ: {{pickupLocation}}\nپتہ: {{pickupAddress}}\nہدایات: {{pickupInstructions}}',
    },
    order_delivered: {
      subject: 'آپ کا آرڈر #{{orderNumber}} آپ کو مل گیا ہے — {{storeName}}',
      body: 'سلام {{customerName}}،\n\n{{storeName}} سے آرڈر #{{orderNumber}} آپ کو مل گیا ہے۔ ہمارے ساتھ خریداری کرنے کا شکریہ۔',
    },
    order_cancelled: {
      subject: '{{storeName}} سے آپ کا آرڈر #{{orderNumber}} منسوخ کر دیا گیا ہے',
      body: 'سلام {{customerName}}،\n\n{{storeName}} سے آرڈر #{{orderNumber}} منسوخ کر دیا گیا ہے۔\n\n{{itemList}}\n\nاگر رقم واپس کی جانی ہو تو آپ کو ریفنڈ کی الگ ای میل موصول ہو گی۔ کوئی سوال ہو تو بس اس ای میل کا جواب دیں۔',
    },
    order_refunded: {
      subject: '{{storeName}} سے آرڈر #{{orderNumber}} کا ریفنڈ',
      body: 'سلام {{customerName}}،\n\nہم نے {{storeName}} سے آرڈر #{{orderNumber}} کے لیے {{refundAmount}} واپس کر دیے ہیں۔\n\nریفنڈ کا طریقہ: {{refundMethod}}\n\nکوئی سوال ہو تو بس اس ای میل کا جواب دیں۔',
    },
    order_edited: {
      subject: '{{storeName}} سے آپ کا آرڈر #{{orderNumber}} اپڈیٹ کر دیا گیا ہے',
      body: 'سلام {{customerName}}،\n\n{{storeName}} نے آرڈر #{{orderNumber}} میں تبدیلی کی ہے۔\n\nنئی کل رقم: {{newTotal}}\n{{changeNote}}\n\nکوئی سوال ہو تو بس اس ای میل کا جواب دیں۔',
    },
    return_update: {
      subject: '{{updateTitle}} — {{storeName}} سے آرڈر #{{orderNumber}}',
      body: 'سلام {{customerName}}،\n\n{{updateTitle}}\n{{updateMessage}}\n\n{{storeName}} سے آرڈر #{{orderNumber}}۔\nکوئی سوال ہو تو بس اس ای میل کا جواب دیں۔',
    },
    draft_order_invoice: {
      subject: '{{storeName}} کی طرف سے انوائس — {{invoiceTotal}}',
      body: 'سلام {{customerName}}،\n\n{{storeName}} کی طرف سے آپ کے لیے {{invoiceTotal}} کی نئی انوائس ہے۔\n{{dueText}}\n\nآن لائن محفوظ ادائیگی کے لیے نیچے دیا گیا بٹن استعمال کریں۔',
    },
    draft_order_overdue: {
      subject: '{{storeName}} کی طرف سے واجب الادا انوائس — {{invoiceTotal}}',
      body: 'سلام {{customerName}}،\n\n{{storeName}} کی {{invoiceTotal}} کی انوائس کی آخری تاریخ {{dueDate}} تھی اور ادائیگی ابھی باقی ہے۔\n\nآن لائن محفوظ ادائیگی کے لیے نیچے دیا گیا بٹن استعمال کریں۔',
    },
    gift_card: {
      subject: 'آپ کو {{storeName}} کی طرف سے {{giftCardValue}} کا گفٹ کارڈ ملا ہے',
      body: 'سلام {{customerName}}،\n\nآپ کو {{storeName}} کا گفٹ کارڈ موصول ہوا ہے۔\n\n{{giftCardMessage}}\n\nآپ کا کوڈ: {{giftCardCode}}\nقدر: {{giftCardValue}}\n\nاسے استعمال کرنے کے لیے {{storeName}} پر چیک آؤٹ کے وقت یہ کوڈ درج کریں۔',
    },
    gift_card_updated: {
      subject: 'آپ کا {{storeName}} گفٹ کارڈ اپڈیٹ کر دیا گیا ہے',
      body: 'سلام {{customerName}}،\n\n{{storeName}} کا آپ کا گفٹ کارڈ اپڈیٹ کیا گیا ہے۔\n\n{{giftCardChange}}\n{{giftCardReason}}\n\nگفٹ کارڈ کوڈ: {{giftCardCode}}\nموجودہ بیلنس: {{giftCardBalance}}',
    },
  },
};

const RTL = new Set(['ur', 'ar', 'he', 'fa']);

export function isRtlLocale(locale: string | null | undefined): boolean {
  return RTL.has(String(locale ?? '').toLowerCase().split('-')[0]);
}

/** The language a customer email is really written in: the order's language when we have built-in strings for it, else English. */
export function emailUiStrings(locale: string | null | undefined): EmailUiStrings {
  return EMAIL_UI_STRINGS[String(locale ?? '').toLowerCase().split('-')[0]] ?? EMAIL_UI_STRINGS.en;
}
