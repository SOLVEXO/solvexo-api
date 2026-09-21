/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { isAppBlockType, parseAppBlockType, APP_BLOCK_TYPE_PREFIX } from '../common/store-content/app-block.util';
import { APP_CATALOG, findApp, findAppBlockDefinition, validateAppBlockSettings } from './app-catalog';

interface SectionLike {
  type: string;
  settings?: Record<string, any>;
  blocks?: { type: string; settings?: Record<string, any> }[];
}

@Injectable()
export class AppsService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get appInstallationModel() {
    return this.databaseService.repositories.appInstallationModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }
  private get storePageModel() {
    return this.databaseService.repositories.storePageModel;
  }
  private get collectionTemplateModel() {
    return this.databaseService.repositories.collectionTemplateModel;
  }

  /** The full static catalog, annotated with this store's real install
   *  state — used by the seller-facing Apps page (browse/install/uninstall)
   *  and by the Customize editor's "Add Block" picker (installed only). */
  async listCatalogForStore(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const installed = await this.appInstallationModel.find({ storeId }).lean();
    const installedIds = new Set(installed.map(i => i.appId));
    return {
      success: true,
      data: APP_CATALOG.map(app => ({ ...app, installed: installedIds.has(app.id) })),
    };
  }

  async install(storeId: string, sellerId: string, appId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    if (!findApp(appId)) throw new NotFoundException(`Unknown app "${appId}"`);
    // Idempotent — installing an already-installed app is a no-op success,
    // not an error (matches this app's own "upsert" convention elsewhere).
    await this.appInstallationModel.findOneAndUpdate(
      { storeId, appId },
      { $setOnInsert: { storeId, appId } },
      { upsert: true },
    );
    return { success: true, message: 'App installed' };
  }

  /** Real cleanup, not just severing the install row — every block this
   *  app provided is stripped from EVERY one of this store's real content
   *  documents (every StorePage, every CollectionTemplate — live AND
   *  draft), so an uninstalled app can never leave an orphaned, un-
   *  renderable block sitting in a merchant's content. Fetch-filter-save
   *  rather than a single aggregation pipeline — uninstall is a rare,
   *  low-frequency action, and this keeps the logic simple and obviously
   *  correct rather than fighting Mongo's nested-array update syntax. */
  async uninstall(storeId: string, sellerId: string, appId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const prefix = `${APP_BLOCK_TYPE_PREFIX}${appId}:`;
    const stripAppBlocks = (sections: SectionLike[] | undefined) =>
      (sections ?? []).map(s => ({ ...s, blocks: (s.blocks ?? []).filter(b => !b.type.startsWith(prefix)) }));

    const pages = await this.storePageModel.find({ storeId });
    for (const page of pages) {
      const liveNext = stripAppBlocks(page.sections as any);
      const draftNext = stripAppBlocks(page.draft?.sections as any);
      if (JSON.stringify(liveNext) !== JSON.stringify(page.sections) || JSON.stringify(draftNext) !== JSON.stringify(page.draft?.sections)) {
        page.sections = liveNext as any;
        if (page.draft) page.draft.sections = draftNext as any;
        // `validateBeforeSave: false` — this cascade only ever touches
        // `sections`/`draft.sections`; it must not fail (and block real
        // cleanup) because some unrelated, pre-existing field on this page
        // fails a validator that has nothing to do with what's being saved
        // here (found live: a legacy StorePage missing `slug`).
        await page.save({ validateBeforeSave: false });
      }
    }

    const templates = await this.collectionTemplateModel.find({ storeId });
    for (const tpl of templates) {
      const liveNext = stripAppBlocks(tpl.sections as any);
      const draftNext = stripAppBlocks(tpl.draft?.sections as any);
      if (JSON.stringify(liveNext) !== JSON.stringify(tpl.sections) || JSON.stringify(draftNext) !== JSON.stringify(tpl.draft?.sections)) {
        tpl.sections = liveNext as any;
        if (tpl.draft) tpl.draft.sections = draftNext as any;
        await tpl.save({ validateBeforeSave: false });
      }
    }

    await this.appInstallationModel.deleteOne({ storeId, appId });
    return { success: true, message: 'App uninstalled — its blocks were removed from every page and template.' };
  }

  /**
   * The real, DB-aware half of app-block validation (the pure, sync half —
   * "is this a well-formed app-block type, does its schema match its
   * settings" — lives in `app-catalog.ts`). Called from every service that
   * saves a real `Section[]` (`StorePagesService`, `CollectionTemplateService`)
   * right after their own first-party `validateSections`, which already lets
   * an app-block-shaped type through untouched via `validateBlocksOfType`'s
   * `allowAppBlocks` flag — this is the second half of that same check.
   *
   * Enforces, per block, in order: (1) it's a real catalog block, (2) the
   * app is actually installed for THIS store — the tenant-isolation
   * boundary; a store can never use another store's or an uninstalled
   * app's block, (3) the block's PARENT section type is in that block's
   * own declared `supportedSectionTypes`, (4) its settings pass that
   * block's own schema.
   */
  async assertBlocksAllowed(storeId: string, sections: SectionLike[]): Promise<void> {
    const appBlockTypes = new Set<string>();
    for (const section of sections) {
      for (const block of section.blocks ?? []) {
        if (isAppBlockType(block.type)) appBlockTypes.add(block.type);
      }
    }
    if (appBlockTypes.size === 0) return;

    const installedRows = await this.appInstallationModel.find({ storeId }).lean();
    const installedAppIds = new Set(installedRows.map(r => r.appId));

    for (const section of sections) {
      for (const block of section.blocks ?? []) {
        if (!isAppBlockType(block.type)) continue;
        const parsed = parseAppBlockType(block.type);
        if (!parsed) throw new BadRequestException(`Malformed app block type: "${block.type}"`);
        const found = findAppBlockDefinition(block.type);
        if (!found) throw new BadRequestException(`Unknown app block type: "${block.type}"`);
        if (!installedAppIds.has(parsed.appId)) {
          throw new ForbiddenException(`The "${found.app.name}" app is not installed for this store`);
        }
        if (!found.block.supportedSectionTypes.includes(section.type as any)) {
          throw new BadRequestException(`The "${found.block.label}" app block cannot be used in a "${section.type}" section`);
        }
        validateAppBlockSettings(found.block, block.settings);
      }
    }
  }
}
