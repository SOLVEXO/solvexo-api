/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MarketingAutomationSettingsDocument = HydratedDocument<MarketingAutomationSettings>;

/* Plain-text bodies with {{customerName}}/{{storeName}} (and per-type tags —
 * see AUTOMATION_MERGE_TAGS) merge tags, escaped and turned into paragraphs at
 * send time. Defaults live in DEFAULT_AUTOMATION_SETTINGS so a store that has
 * never opened the screen still behaves sensibly. */

@Schema({ _id: false })
export class WelcomeAutomation {
  @Prop({ default: true }) enabled: boolean;
  @Prop({ default: '' }) subject: string;
  @Prop({ default: '' }) message: string;
  // Optional — an existing coupon code the seller created under Discounts.
  @Prop({ type: String, default: null }) discountCode: string | null;
  // Drag-and-drop editor design (web app's EmailDesign JSON) and its rendered
  // HTML with {{tags}}; when set, it replaces the plain-text message.
  @Prop({ type: Object, default: null }) design: Record<string, unknown> | null;
  @Prop({ type: String, default: null }) html: string | null;
}

@Schema({ _id: false })
export class BackInStockAutomation {
  @Prop({ default: true }) enabled: boolean;
  @Prop({ default: '' }) subject: string;
  @Prop({ default: '' }) message: string;
  // Drag-and-drop editor design (web app's EmailDesign JSON) and its rendered
  // HTML with {{tags}}; when set, it replaces the plain-text message.
  @Prop({ type: Object, default: null }) design: Record<string, unknown> | null;
  @Prop({ type: String, default: null }) html: string | null;
}

@Schema({ _id: false })
export class PriceDropAutomation {
  @Prop({ default: false }) enabled: boolean;
  @Prop({ default: 10, min: 1, max: 90 }) minDropPercent: number;
  @Prop({ default: '' }) subject: string;
  @Prop({ default: '' }) message: string;
  // Drag-and-drop editor design (web app's EmailDesign JSON) and its rendered
  // HTML with {{tags}}; when set, it replaces the plain-text message.
  @Prop({ type: Object, default: null }) design: Record<string, unknown> | null;
  @Prop({ type: String, default: null }) html: string | null;
}

@Schema({ _id: false })
export class WinBackAutomation {
  @Prop({ default: false }) enabled: boolean;
  @Prop({ default: 60, min: 14, max: 365 }) afterDays: number;
  @Prop({ default: '' }) subject: string;
  @Prop({ default: '' }) message: string;
  @Prop({ type: String, default: null }) discountCode: string | null;
  // Drag-and-drop editor design (web app's EmailDesign JSON) and its rendered
  // HTML with {{tags}}; when set, it replaces the plain-text message.
  @Prop({ type: Object, default: null }) design: Record<string, unknown> | null;
  @Prop({ type: String, default: null }) html: string | null;
}

@Schema({ timestamps: true })
export class MarketingAutomationSettings {
  _id: string;

  @Prop({ required: true, unique: true })
  storeId: string;

  @Prop({ type: WelcomeAutomation, default: () => ({}) })
  welcome: WelcomeAutomation;

  @Prop({ type: BackInStockAutomation, default: () => ({}) })
  backInStock: BackInStockAutomation;

  @Prop({ type: PriceDropAutomation, default: () => ({}) })
  priceDrop: PriceDropAutomation;

  @Prop({ type: WinBackAutomation, default: () => ({}) })
  winBack: WinBackAutomation;

  // Double opt-in (Shopify: "Confirm email subscription") — storefront and
  // checkout sign-ups get a confirmation email and only become subscribers
  // once they click it. Seller-added/imported contacts are not affected.
  @Prop({ default: false })
  doubleOptIn: boolean;
}

export const MarketingAutomationSettingsSchema = SchemaFactory.createForClass(MarketingAutomationSettings);

export const DEFAULT_AUTOMATION_SETTINGS = {
  doubleOptIn: false,
  welcome: {
    enabled: true,
    subject: 'Welcome to {{storeName}}',
    message: "Hi {{customerName}},\n\nThanks for subscribing! You'll be the first to hear about new arrivals, exclusive offers and sales from {{storeName}}.",
    discountCode: null as string | null,
    design: null as Record<string, unknown> | null,
    html: null as string | null,
  },
  backInStock: {
    enabled: true,
    subject: '{{productName}} is back in stock',
    message: "Good news — {{productName}} is available again at {{storeName}}. Popular items sell out fast, so grab yours while it's here.",
    design: null as Record<string, unknown> | null,
    html: null as string | null,
  },
  priceDrop: {
    enabled: false,
    minDropPercent: 10,
    subject: 'Price drop: {{productName}} is now {{newPrice}}',
    message: 'Hi {{customerName}},\n\nAn item on your wishlist just got cheaper. {{productName}} dropped from {{oldPrice}} to {{newPrice}}.',
    design: null as Record<string, unknown> | null,
    html: null as string | null,
  },
  winBack: {
    enabled: false,
    afterDays: 60,
    subject: 'We miss you at {{storeName}}',
    message: "Hi {{customerName}},\n\nIt's been a while! Come see what's new at {{storeName}} — we'd love to have you back.",
    discountCode: null as string | null,
    design: null as Record<string, unknown> | null,
    html: null as string | null,
  },
};

export type AutomationSettingsShape = typeof DEFAULT_AUTOMATION_SETTINGS;

/** Merges a stored row (possibly partial / empty strings) over the defaults. */
export function resolveAutomationSettings(row: Partial<MarketingAutomationSettings> | null | undefined): AutomationSettingsShape {
  const pick = <T extends Record<string, any>>(defaults: T, stored: any): T => {
    const out: any = { ...defaults };
    if (stored) {
      for (const key of Object.keys(defaults)) {
        const v = stored[key];
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v.trim() === '' && typeof defaults[key] === 'string') continue;
        out[key] = v;
      }
    }
    return out;
  };
  return {
    doubleOptIn: typeof row?.doubleOptIn === "boolean" ? row.doubleOptIn : DEFAULT_AUTOMATION_SETTINGS.doubleOptIn,
    welcome: pick(DEFAULT_AUTOMATION_SETTINGS.welcome, row?.welcome),
    backInStock: pick(DEFAULT_AUTOMATION_SETTINGS.backInStock, row?.backInStock),
    priceDrop: pick(DEFAULT_AUTOMATION_SETTINGS.priceDrop, row?.priceDrop),
    winBack: pick(DEFAULT_AUTOMATION_SETTINGS.winBack, row?.winBack),
  };
}
