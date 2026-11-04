import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { filterSectionsToTheme } from '../common/store-content/theme-section-capabilities';

/**
 * Switching theme keeps what the seller WROTE (logos, menus, links, texts, page and product layouts) and
 * leaves what the theme DESIGNS (colours come from the Brand Kit, shapes, fonts, header/footer layout style,
 * `themeSettings`) to the new theme. Works between any two installed themes, in both directions.
 * Header and footer content is what is LIVE on the source theme. Page and product layouts also bring their unpublished draft (an empty draft follows what is live).
 * Nothing of the source theme is touched; the target's previous content is kept as a version so it can be restored.
 */

/** Header fields that hold seller content, not theme design. */
export const HEADER_CONTENT_KEYS = [
  'logoSource', 'customLogoUrl', 'logoLink', 'blocks', 'sections', 'menuId',
  'shopMenuLabel', 'blogLinkLabel', 'includePagesInNav', 'showDefaultBlogLink', 'showShopMenu',
  'showSearch', 'showAccount', 'showWishlist',
  'ctaLabel', 'ctaLink', 'topBarEnabled', 'topBarText', 'topBarPhone', 'topBarEmail',
] as const;

/** Footer fields that hold seller content, not theme design. */
export const FOOTER_CONTENT_KEYS = [
  'blocks', 'sections', 'menuId', 'logoSource', 'logoUrl', 'logoLink',
  'showNewsletter', 'newsletterHeading', 'newsletterText',
  'showDefaultColumns', 'shopColumnHeading', 'accountColumnHeading', 'blogLinkLabel',
  'showPolicyLinks', 'blockLayout',
] as const;

/** Namespace a theme uses for its own `theme_section` keys (`maison.lookbook`, `tech.bento_grid`). */
const THEME_NAMESPACE: Record<string, string> = { 'theme-03-fashion': 'maison', 'theme-04-tech': 'tech' };

export interface CarryResult {
  header: boolean;
  footer: boolean;
  pages: number;
  templates: number;
  /** Sections the new theme has no renderer for (they stay in the source theme). */
  skippedSections: number;
}

type AnySection = { type: string; settings?: Record<string, any>; blocks?: any[] } & Record<string, any>;

/** Sections the target theme can show: platform sections it accepts, plus only its OWN theme-defined ones. */
export function carrySections(sections: AnySection[] | undefined | null, targetThemeId: string): { kept: AnySection[]; skipped: number } {
  const list = Array.isArray(sections) ? sections : [];
  const accepted = filterSectionsToTheme(list, targetThemeId);
  const ns = THEME_NAMESPACE[targetThemeId];
  const kept = accepted.filter(s => {
    if (s.type !== 'theme_section') return true;
    const key = String(s.settings?.sectionKey ?? '');
    return !!ns && key.startsWith(`${ns}.`);
  });
  return { kept, skipped: list.length - kept.length };
}

const pick = (src: Record<string, any> | undefined | null, keys: readonly string[]) => {
  const out: Record<string, any> = {};
  for (const k of keys) if (src && src[k] !== undefined) out[k] = src[k];
  return out;
};

@Injectable()
export class ThemeContentCarryService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get themeModel() { return this.databaseService.repositories.storeThemeModel; }
  private get pageModel() { return this.databaseService.repositories.storePageModel; }
  private get templateModel() { return this.databaseService.repositories.collectionTemplateModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  async carry(storeId: string, sellerId: string, targetId: string, fromId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const target: any = await this.themeModel.findOne({ _id: targetId, storeId }).lean();
    if (!target) throw new NotFoundException('Installed theme not found');
    const source: any = fromId
      ? await this.themeModel.findOne({ _id: fromId, storeId }).lean()
      : await this.themeModel.findOne({ storeId, status: 'active', _id: { $ne: targetId } }).lean();
    if (!source) throw new BadRequestException('Choose the theme to copy your content from');
    if (String(source._id) === String(target._id)) throw new BadRequestException('Pick a different theme to copy from');
    if (!target.themeDefinitionId) throw new BadRequestException('The installed theme has no registered section capabilities');

    const result: CarryResult = { header: false, footer: false, pages: 0, templates: 0, skippedSections: 0 };
    const now = new Date();
    const srcLive = { header: source.header ?? {}, footer: source.footer ?? {} };

    // Header + footer content (live and draft), after keeping the target's current look as a restorable version.
    const $set: Record<string, any> = {};
    for (const [k, v] of Object.entries(pick(srcLive.header, HEADER_CONTENT_KEYS))) $set[`header.${k}`] = v;
    for (const [k, v] of Object.entries(pick(srcLive.header, HEADER_CONTENT_KEYS))) $set[`draft.header.${k}`] = v;
    for (const [k, v] of Object.entries(pick(srcLive.footer, FOOTER_CONTENT_KEYS))) $set[`footer.${k}`] = v;
    for (const [k, v] of Object.entries(pick(srcLive.footer, FOOTER_CONTENT_KEYS))) $set[`draft.footer.${k}`] = v;
    if (Object.keys($set).length) {
      await this.themeModel.updateOne({ _id: target._id }, {
        $set,
        $push: { versions: { $each: [{
          theme: target.theme, header: target.header, footer: target.footer, identityBanner: target.identityBanner,
          baseThemeId: target.baseThemeId ?? null, themeDefinitionId: target.themeDefinitionId, publishedAt: now,
        }], $slice: -20 } },
      });
      result.header = Object.keys(pick(srcLive.header, HEADER_CONTENT_KEYS)).length > 0;
      result.footer = Object.keys(pick(srcLive.footer, FOOTER_CONTENT_KEYS)).length > 0;
    }

    // Page layouts: home + every custom page.
    const sId = String(source._id);
    const tId = String(target._id);
    const pages: any[] = await this.pageModel.find({ storeId, isDelete: false }).lean();
    for (const page of pages) {
      const srcT = page.themeTemplates?.find((t: any) => String(t.installedThemeId) === sId);
      // A theme that never had its own copy shows the page's legacy sections.
      const liveRaw = srcT ? srcT.sections : page.sections;
      const live = carrySections(liveRaw, target.themeDefinitionId);
      // Unpublished page edits travel too; a page whose draft is empty simply follows what is live.
      const draftSrc = Array.isArray(srcT?.draftSections) && srcT.draftSections.length ? srcT.draftSections : liveRaw;
      const draft = carrySections(draftSrc, target.themeDefinitionId);
      result.skippedSections += Math.max(live.skipped, draft.skipped);
      const existing = page.themeTemplates?.find((t: any) => String(t.installedThemeId) === tId);
      if (existing) {
        const upd: any = { $set: { 'themeTemplates.$.sections': live.kept, 'themeTemplates.$.draftSections': draft.kept, 'themeTemplates.$.lastPublishedAt': srcT?.lastPublishedAt ?? page.lastPublishedAt ?? now } };
        if (Array.isArray(existing.sections) && existing.sections.length) {
          upd.$push = { 'themeTemplates.$.versions': { $each: [{ sections: existing.sections, publishedAt: now }], $slice: -20 } };
        }
        await this.pageModel.updateOne({ _id: page._id, storeId, 'themeTemplates.installedThemeId': tId }, upd);
      } else {
        await this.pageModel.updateOne(
          { _id: page._id, storeId, 'themeTemplates.installedThemeId': { $ne: tId } },
          { $push: { themeTemplates: { installedThemeId: tId, sections: live.kept, draftSections: draft.kept, lastPublishedAt: srcT?.lastPublishedAt ?? page.lastPublishedAt ?? null, versions: [] } } },
        );
      }
      result.pages++;
    }

    // Product / collection / customer-page templates.
    const srcTemplates: any[] = await this.templateModel.find({ storeId, installedThemeId: sId }).lean();
    for (const tpl of srcTemplates) {
      const live = carrySections(tpl.sections, target.themeDefinitionId);
      const draftSrc = Array.isArray(tpl.draft?.sections) && tpl.draft.sections.length ? tpl.draft.sections : tpl.sections;
      const draft = carrySections(draftSrc, target.themeDefinitionId);
      result.skippedSections += Math.max(live.skipped, draft.skipped);
      const filter = { storeId, installedThemeId: tId, resourceType: tpl.resourceType, templateKey: tpl.templateKey };
      const existing: any = await this.templateModel.findOne(filter).lean();
      if (existing) {
        const upd: any = { $set: { sections: live.kept, 'draft.sections': draft.kept, lastPublishedAt: tpl.lastPublishedAt ?? now, status: tpl.status } };
        if (Array.isArray(existing.sections) && existing.sections.length) {
          upd.$push = { versions: { $each: [{ sections: existing.sections, publishedAt: now }], $slice: -20 } };
        }
        await this.templateModel.updateOne({ _id: existing._id }, upd);
      } else {
        await this.templateModel.create({
          ...filter, name: tpl.name, isDefault: tpl.isDefault, sections: live.kept, draft: { ...(tpl.draft ?? {}), sections: draft.kept },
          lastPublishedAt: tpl.lastPublishedAt ?? null, status: tpl.status, versions: [],
        });
      }
      result.templates++;
    }

    return { success: true, message: 'Your content was copied to this theme', data: result };
  }
}
