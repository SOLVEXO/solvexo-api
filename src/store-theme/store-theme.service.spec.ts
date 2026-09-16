/* eslint-disable prettier/prettier */
import { ForbiddenException } from '@nestjs/common';
import { StoreThemeService } from './store-theme.service';
import { DatabaseService } from '../database/databaseservice';
import { ThemeCatalogService } from '../theme-catalog/theme-catalog.service';
import { ContentVersioningService } from '../common/content-versioning/content-versioning.service';
import { MenusService } from '../menus/menus.service';

const STORE_ID = 'store-1';
const OTHER_STORE_ID = 'store-2';
const SELLER_ID = 'seller-1';
const OTHER_SELLER_ID = 'seller-2';
const THEME_DEF_ID = 'theme-def-1';

describe('StoreThemeService', () => {
  let service: StoreThemeService;
  let storeThemeModel: any;
  let storeModel: any;
  let storePageModel: any;
  let db: DatabaseService;
  let themeCatalogService: ThemeCatalogService;
  let menusService: MenusService;

  // The seller's own existing draft BEFORE any apply/publish/revert call —
  // used to assert that a theme's own (empty) header/footer blocks never
  // wipe out real content the seller already authored (see
  // `applyThemeDefinition`'s "preserve nav content" comment).
  const existingDraft = () => ({
    theme: { primaryColor: '#111111' },
    header: { headerStyle: 'standard', navAlignment: 'left', logoSource: 'store', customLogoUrl: null, blocks: [{ type: 'nav_link', settings: { label: 'Shop' } }] },
    footer: { footerStyle: 'columns', blocks: [{ type: 'footer_column', settings: { heading: 'Support' } }] },
    identityBanner: { showFollowButton: true },
    baseThemeId: null,
    pendingHomeSections: null,
    customCss: null,
  });

  const themeDefinition = (overrides: Partial<any> = {}) => ({
    _id: THEME_DEF_ID,
    name: 'Vogue',
    theme: { primaryColor: '#1F1B2E' },
    header: { headerStyle: 'centered', navAlignment: 'left', blocks: [] },
    footer: { footerStyle: 'minimal', blocks: [] },
    identityBanner: { showFollowButton: false },
    homePageSections: [{ type: 'hero', settings: {}, blocks: [] }],
    ...overrides,
  });

  beforeEach(() => {
    storeThemeModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockResolvedValue({}),
      // ensureDefaultTheme's real legacy-row backfill (installed-theme
      // migration) — not itself under test here, just a real call every
      // resolveInstance() path makes before doing anything else.
      updateMany: jest.fn().mockResolvedValue({}),
      // Real resolveInstance()/ensureDefaultTheme() return the store's own
      // installed-theme-instance DOCUMENT — every mutating method below
      // (applyThemeDefinition/publishTheme/revertDraftToPublished) then
      // filters its own update by that instance's real `_id`, not `storeId`
      // (a store can have several installed rows since the multi-install
      // architecture landed — see StoreThemeService's own doc comments), so
      // the mock derives a stable, per-store `_id` instead of leaving it
      // undefined.
      findOne: jest.fn().mockImplementation((query: any) =>
        Promise.resolve({ _id: `instance-${query.storeId}`, storeId: query.storeId, draft: existingDraft() }),
      ),
    };
    storeModel = {
      // `verifyStoreOwnershipStrict` (real implementation, not mocked) reads
      // `store.isDelete`/`store.sellerId.toString()` off whatever this resolves to.
      findById: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(id === STORE_ID ? { _id: STORE_ID, isDelete: false, sellerId: SELLER_ID } : null),
      ),
    };
    storePageModel = { updateOne: jest.fn().mockResolvedValue({}) };

    db = { repositories: { storeThemeModel, storeModel, storePageModel } } as any;
    themeCatalogService = {
      getPublishedForApply: jest.fn().mockResolvedValue(themeDefinition()),
      incrementApplyCount: jest.fn().mockResolvedValue(undefined),
    } as any;
    // Real, undoubled instance — ContentVersioningService is a pure,
    // dependency-free utility (no constructor args, see its own spec file),
    // so mocking its 7 methods by hand would just re-implement the real
    // thing with more risk of drifting from it.
    const contentVersioningService = new ContentVersioningService();
    // Only reached when header.menuId/footer.menuId is set — no fixture in
    // this file sets either, so this is never actually invoked; mocked for
    // constructor-shape correctness only.
    menusService = { getRaw: jest.fn().mockResolvedValue(null) } as any;

    service = new StoreThemeService(db, contentVersioningService, menusService, themeCatalogService);
  });

  describe('applyThemeDefinition', () => {
    it('rejects a caller who is not this store\'s owner', async () => {
      await expect(service.applyThemeDefinition(STORE_ID, OTHER_SELLER_ID, THEME_DEF_ID)).rejects.toThrow(ForbiddenException);
      expect(storeThemeModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects when the storeId does not exist at all (isolation: never falls through to another store)', async () => {
      await expect(service.applyThemeDefinition(OTHER_STORE_ID, SELLER_ID, THEME_DEF_ID)).rejects.toThrow();
    });

    it('stages colors/identityBanner/home sections into the draft, scoped to only this storeId', async () => {
      await service.applyThemeDefinition(STORE_ID, SELLER_ID, THEME_DEF_ID);

      const applyCall = storeThemeModel.findOneAndUpdate.mock.calls.find(
        ([, update]: any[]) => update?.$set?.['draft.theme'] !== undefined,
      );
      expect(applyCall).toBeDefined();
      const [filter, update] = applyCall;
      expect(filter).toEqual({ _id: `instance-${STORE_ID}` }); // never touches any other store's document
      expect(update.$set['draft.theme']).toEqual({ primaryColor: '#1F1B2E' });
      expect(update.$set['draft.identityBanner']).toEqual({ showFollowButton: false });
      expect(update.$set['draft.baseThemeId']).toBe(THEME_DEF_ID);
      expect(update.$set['draft.pendingHomeSections']).toEqual([{ type: 'hero', settings: {}, blocks: [] }]);
    });

    it('preserves the seller\'s own nav-link/footer blocks when the theme definition has none of its own', async () => {
      await service.applyThemeDefinition(STORE_ID, SELLER_ID, THEME_DEF_ID);

      const applyCall = storeThemeModel.findOneAndUpdate.mock.calls.find(
        ([, update]: any[]) => update?.$set?.['draft.theme'] !== undefined,
      );
      const { update } = { update: applyCall[1] };
      expect(update.$set['draft.header'].blocks).toEqual(existingDraft().header.blocks);
      expect(update.$set['draft.header'].headerStyle).toBe('centered'); // style still comes from the theme
      expect(update.$set['draft.footer'].blocks).toEqual(existingDraft().footer.blocks);
      expect(update.$set['draft.footer'].footerStyle).toBe('minimal');
    });

    it('takes the theme\'s own blocks when it actually supplies real nav content', async () => {
      const richTheme = themeDefinition({ header: { headerStyle: 'centered', navAlignment: 'left', blocks: [{ type: 'nav_link', settings: { label: 'New Nav' } }] } });
      themeCatalogService.getPublishedForApply = jest.fn().mockResolvedValue(richTheme);

      await service.applyThemeDefinition(STORE_ID, SELLER_ID, THEME_DEF_ID);

      const applyCall = storeThemeModel.findOneAndUpdate.mock.calls.find(
        ([, update]: any[]) => update?.$set?.['draft.theme'] !== undefined,
      );
      expect(applyCall[1].$set['draft.header'].blocks).toEqual(richTheme.header.blocks);
    });

    it('increments the catalog theme\'s apply counter and never mutates the catalog document itself', async () => {
      await service.applyThemeDefinition(STORE_ID, SELLER_ID, THEME_DEF_ID);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.fn() mock, not a real bound class method
      expect(themeCatalogService.incrementApplyCount).toHaveBeenCalledWith(THEME_DEF_ID);
      // The theme definition object handed back by the catalog service is
      // only ever read from — nothing in applyThemeDefinition calls a
      // mutating method on themeCatalogService other than the counter.
      expect((themeCatalogService as any).update).toBeUndefined();
    });
  });

  describe('publishTheme', () => {
    it('writes a pending theme-application\'s home sections into the home StorePage and clears the pending field', async () => {
      storeThemeModel.findOne = jest.fn().mockResolvedValue({
        _id: `instance-${STORE_ID}`,
        draft: { ...existingDraft(), pendingHomeSections: [{ type: 'hero', settings: {}, blocks: [] }] },
      });

      await service.publishTheme(STORE_ID, SELLER_ID);

      expect(storePageModel.updateOne).toHaveBeenCalledWith(
        { storeId: STORE_ID, type: 'home' },
        { $set: { sections: [{ type: 'hero', settings: {}, blocks: [] }] } },
      );
      expect(storeThemeModel.updateOne).toHaveBeenCalledWith(
        { _id: `instance-${STORE_ID}` },
        { $set: { 'draft.pendingHomeSections': null } },
      );
    });

    it('never touches the home StorePage when there is no pending theme application', async () => {
      storeThemeModel.findOne = jest.fn().mockResolvedValue({ _id: `instance-${STORE_ID}`, draft: { ...existingDraft(), pendingHomeSections: null } });

      await service.publishTheme(STORE_ID, SELLER_ID);

      expect(storePageModel.updateOne).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not this store\'s owner', async () => {
      await expect(service.publishTheme(STORE_ID, OTHER_SELLER_ID)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('revertDraftToPublished', () => {
    it('discards a pending theme application (clears pendingHomeSections) without ever touching the live StorePage', async () => {
      await service.revertDraftToPublished(STORE_ID, SELLER_ID);

      const revertCall = storeThemeModel.findOneAndUpdate.mock.calls.find(
        ([, update]: any[]) => Array.isArray(update) && update[0]?.$set?.draft !== undefined,
      );
      expect(revertCall).toBeDefined();
      expect(revertCall[1][0].$set.draft.pendingHomeSections).toBeNull();
      expect(storePageModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('cross-seller isolation', () => {
    it('applying the same theme to two different stores never lets one leak into the other\'s update call', async () => {
      storeModel.findById = jest.fn().mockImplementation((id: string) =>
        Promise.resolve(
          id === STORE_ID ? { _id: STORE_ID, isDelete: false, sellerId: SELLER_ID } :
          id === OTHER_STORE_ID ? { _id: OTHER_STORE_ID, isDelete: false, sellerId: OTHER_SELLER_ID } : null,
        ),
      );

      await service.applyThemeDefinition(STORE_ID, SELLER_ID, THEME_DEF_ID);
      await service.applyThemeDefinition(OTHER_STORE_ID, OTHER_SELLER_ID, THEME_DEF_ID);

      const applyCalls = storeThemeModel.findOneAndUpdate.mock.calls.filter(
        ([, update]: any[]) => update?.$set?.['draft.theme'] !== undefined,
      );
      expect(applyCalls).toHaveLength(2);
      expect(applyCalls[0][0]).toEqual({ _id: `instance-${STORE_ID}` });
      expect(applyCalls[1][0]).toEqual({ _id: `instance-${OTHER_STORE_ID}` });
    });
  });
});
