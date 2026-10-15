import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { normalizeLocale } from '@/markets/market-price.util';
import { SaveTranslationDto } from './dto/translation.dto';

export const TRANSLATION_RESOURCES = ['products', 'collections', 'pages', 'menus'] as const;
export type TranslationResource = (typeof TRANSLATION_RESOURCES)[number];

export function isTranslationResource(v: unknown): v is TranslationResource {
  return typeof v === 'string' && (TRANSLATION_RESOURCES as readonly string[]).includes(v);
}

const MAX_LABEL = 120;
const MAX_PAGE_SIZE = 50;
const HANDLE = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

interface ResourceDef {
  model: 'productModel' | 'collectionModel' | 'storePageModel' | 'menuModel';
  title: string;
  description: string | null;
  handle: string | null;
  softDelete: boolean;
}

const DEFS: Record<TranslationResource, ResourceDef> = {
  products: { model: 'productModel', title: 'name', description: 'description', handle: 'slug', softDelete: true },
  collections: { model: 'collectionModel', title: 'name', description: 'description', handle: 'slug', softDelete: true },
  pages: { model: 'storePageModel', title: 'title', description: null, handle: 'slug', softDelete: true },
  menus: { model: 'menuModel', title: 'name', description: null, handle: null, softDelete: false },
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A Mongo-stored translations map as the plain object the client gets (the per-entry _id is internal). */
function plainTranslations(raw: any): Record<string, any> {
  const out: Record<string, any> = {};
  const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw ?? {});
  for (const [locale, t] of entries) {
    const { _id, ...rest } = (t as any) ?? {};
    out[locale] = rest;
  }
  return out;
}

function plainLabels(raw: any): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(raw instanceof Map ? raw.entries() : Object.entries(raw));
}

function flattenMenu(items: any[], depth = 0, out: any[] = []): any[] {
  for (const it of items ?? []) {
    out.push({ id: it.id, label: it.label, depth, labelTranslations: plainLabels(it.labelTranslations) });
    if (Array.isArray(it.children)) flattenMenu(it.children, depth + 1, out);
  }
  return out;
}

function mapMenuTree(items: any[], fn: (item: any) => any): any[] {
  return (items ?? []).map((it) => {
    const next = fn({ ...it });
    if (Array.isArray(it.children)) next.children = mapMenuTree(it.children, fn);
    return next;
  });
}

/** Seller-side editing of the per-language text on products, collections, pages and menus. */
@Injectable()
export class TranslationsService {
  constructor(private readonly db: DatabaseService) {}

  private model(resource: TranslationResource): any {
    return (this.db.repositories as any)[DEFS[resource].model];
  }

  private scope(resource: TranslationResource, storeId: string, id?: string): Record<string, any> {
    return { storeId, ...(id ? { _id: id } : {}), ...(DEFS[resource].softDelete ? { isDelete: false } : {}) };
  }

  private shape(resource: TranslationResource, doc: any) {
    const def = DEFS[resource];
    return {
      id: String(doc._id),
      source: {
        title: doc[def.title] ?? '',
        description: def.description ? doc[def.description] ?? null : null,
        handle: def.handle ? doc[def.handle] ?? null : null,
      },
      translations: resource === 'menus' ? {} : plainTranslations(doc.translations),
      ...(resource === 'menus' ? { menuItems: flattenMenu(doc.items ?? []) } : {}),
    };
  }

  private static locale(raw: string): string {
    const locale = normalizeLocale(raw);
    if (!locale || locale === 'en') throw new BadRequestException(`"${raw}" is not a language you can translate into`);
    return locale;
  }

  private static id(id: string): string {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid id');
    return id;
  }

  async list(storeId: string, resource: TranslationResource, query: { page?: string | number; limit?: string | number; q?: string }) {
    const def = DEFS[resource];
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.limit) || 20)));
    const filter = this.scope(resource, storeId);
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    if (q) filter[def.title] = { $regex: escapeRegex(q), $options: 'i' };

    const select = [def.title, def.description, def.handle, resource === 'menus' ? 'items' : 'translations'].filter(Boolean).join(' ');
    const [docs, total] = await Promise.all([
      this.model(resource).find(filter).select(select).sort({ [def.title]: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model(resource).countDocuments(filter),
    ]);
    return {
      items: docs.map((d: any) => this.shape(resource, d)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async save(storeId: string, resource: TranslationResource, id: string, rawLocale: string, dto: SaveTranslationDto) {
    TranslationsService.id(id);
    const locale = TranslationsService.locale(rawLocale);
    if (resource === 'menus') return this.saveMenuLabels(storeId, id, locale, dto);

    const title = String(dto.title ?? '').trim();
    if (!title) throw new BadRequestException('A translated title is required');
    const handle = dto.handle ? String(dto.handle).trim() : null;
    if (handle && !HANDLE.test(handle)) throw new BadRequestException('The handle may only contain letters, numbers, "-" and "_"');
    const def = DEFS[resource];
    const entry = {
      locale,
      title,
      description: def.description && dto.description ? String(dto.description).trim() || null : null,
      handle,
      metaTitle: dto.metaTitle ? String(dto.metaTitle).trim() || null : null,
      metaDescription: dto.metaDescription ? String(dto.metaDescription).trim() || null : null,
    };
    const doc = await this.model(resource)
      .findOneAndUpdate(this.scope(resource, storeId, id), { $set: { [`translations.${locale}`]: entry } }, { new: true })
      .select([def.title, def.description, def.handle, 'translations'].filter(Boolean).join(' '))
      .lean();
    if (!doc) throw new NotFoundException('Not found in this store');
    return this.shape(resource, doc);
  }

  private async saveMenuLabels(storeId: string, id: string, locale: string, dto: SaveTranslationDto) {
    const labels = dto.labels;
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new BadRequestException('labels is required for a menu');
    const menu: any = await this.model('menus').findOne(this.scope('menus', storeId, id)).lean();
    if (!menu) throw new NotFoundException('Menu not found in this store');

    const known = new Set(flattenMenu(menu.items ?? []).map((i) => i.id));
    for (const [itemId, value] of Object.entries(labels)) {
      if (!known.has(itemId)) throw new BadRequestException(`Unknown menu item "${itemId}"`);
      if (typeof value !== 'string' || value.trim().length > MAX_LABEL) throw new BadRequestException(`Labels must be text of at most ${MAX_LABEL} characters`);
    }
    const items = mapMenuTree(menu.items ?? [], (item) => {
      if (!(item.id in labels)) return item;
      const next = plainLabels(item.labelTranslations);
      const text = labels[item.id].trim();
      if (text) next[locale] = text;
      else delete next[locale];
      return { ...item, labelTranslations: next };
    });
    const updated = await this.model('menus').findOneAndUpdate(this.scope('menus', storeId, id), { $set: { items } }, { new: true }).lean();
    return this.shape('menus', updated);
  }

  async remove(storeId: string, resource: TranslationResource, id: string, rawLocale: string) {
    TranslationsService.id(id);
    const locale = TranslationsService.locale(rawLocale);
    if (resource === 'menus') {
      const menu: any = await this.model('menus').findOne(this.scope('menus', storeId, id)).lean();
      if (!menu) throw new NotFoundException('Menu not found in this store');
      const items = mapMenuTree(menu.items ?? [], (item) => {
        const next = plainLabels(item.labelTranslations);
        delete next[locale];
        return { ...item, labelTranslations: next };
      });
      await this.model('menus').updateOne(this.scope('menus', storeId, id), { $set: { items } });
      return;
    }
    const res = await this.model(resource).updateOne(this.scope(resource, storeId, id), { $unset: { [`translations.${locale}`]: '' } });
    if (!res.matchedCount) throw new NotFoundException('Not found in this store');
  }
}
