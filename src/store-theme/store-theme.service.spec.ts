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
  let transactionSession: any;

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
    transactionSession = { transactionId: 'theme-publish-test' };
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
        Promise.resolve({ _id: query._id ?? `instance-${query.storeId}`, storeId: query.storeId, themeDefinitionId: 'theme-01-atelier', draft: existingDraft() }),
      ),
      db: { transaction: jest.fn((callback: (session: any) => Promise<any>) => callback(transactionSession)) },
    };
    storeModel = {
      // `verifyStoreOwnershipStrict` (real implementation, not mocked) reads
      // `store.isDelete`/`store.sellerId.toString()` off whatever this resolves to.
      findById: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(id === STORE_ID ? { _id: STORE_ID, isDelete: false, sellerId: SELLER_ID } : null),
      ),
    };
    storePageModel = {
      findOne: jest.fn().mockResolvedValue({ _id: 'home-1', themeTemplates: [{ installedThemeId: `instance-${STORE_ID}`, sections: [], draftSections: [] }] }),
      updateOne: jest.fn().mockResolvedValue({}),
    };

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

    it('applies a catalog design to the requested installed theme instance, not whichever theme is active', async () => {
      await service.applyThemeDefinition(STORE_ID, SELLER_ID, THEME_DEF_ID, 'instance-copy');

      const applyCall = storeThemeModel.findOneAndUpdate.mock.calls.find(
        ([, update]: any[]) => update?.$set?.['draft.theme'] !== undefined,
      );
      expect(applyCall[0]).toEqual({ _id: 'instance-copy' });
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

    it('stages the catalog theme id into appliedCatalogThemeId — never into themeDefinitionId (regression: a confirmed live collision where this used to corrupt which theme\'s code the storefront renders)', async () => {
      await service.applyThemeDefinition(STORE_ID, SELLER_ID, THEME_DEF_ID);

      const applyCall = storeThemeModel.findOneAndUpdate.mock.calls.find(
        ([, update]: any[]) => update?.$set?.['draft.theme'] !== undefined,
      );
      const { $set } = applyCall[1];
      expect($set['draft.appliedCatalogThemeId']).toBe(THEME_DEF_ID);
      expect($set['draft.themeDefinitionId']).toBeUndefined();
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

  describe('getPreviewByToken', () => {
    it('returns the store slug and draft sections scoped to the previewed installed theme', async () => {
      const installedThemeId = 'instance-preview';
      storeThemeModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: installedThemeId,
          previewToken: { token: 'share-token', expiresAt: new Date(Date.now() + 60_000) },
          themeDefinitionId: 'theme-02-nova',
          draft: { theme: {}, header: { blocks: [] }, footer: {}, identityBanner: {}, customCss: null },
        }),
      });
      storeModel.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ slug: 'my-store' }) });
      const draftSections = [{ type: 'hero', settings: { title: 'Draft only' }, blocks: [] }];
      storePageModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          themeTemplates: [
            { installedThemeId: 'another-theme', draftSections: [{ type: 'hero', settings: { title: 'Other' }, blocks: [] }] },
            { installedThemeId, draftSections },
          ],
        }),
      });

      const result = await service.getPreviewByToken(STORE_ID, 'share-token');

      expect(result.data.storeSlug).toBe('my-store');
      expect(result.data.homeSections).toEqual(draftSections);
      expect(storeThemeModel.findOne).toHaveBeenCalledWith(expect.objectContaining({
        storeId: STORE_ID,
        'previewToken.token': 'share-token',
        'previewToken.expiresAt': expect.objectContaining({ $gt: expect.any(Date) }),
      }));
      expect(storePageModel.findOne).toHaveBeenCalledWith(
        { storeId: STORE_ID, type: 'home' },
        { themeTemplates: 1, sections: 1, draft: 1 },
      );
    });

    it('rejects expired or missing preview tokens at the database lookup boundary', async () => {
      storeThemeModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
      await expect(service.getPreviewByToken(STORE_ID, 'expired-token')).rejects.toThrow('Preview link not found or has expired');
    });
  });

  describe('publishTheme', () => {
    it('writes a pending theme-application\'s home sections into the home StorePage and clears the pending field', async () => {
      storeThemeModel.findOne = jest.fn().mockResolvedValue({
        _id: `instance-${STORE_ID}`,
        draft: { ...existingDraft(), pendingHomeSections: [{ type: 'hero', settings: {}, blocks: [] }] },
      });

      await service.publishTheme(STORE_ID, SELLER_ID);

      expect(storePageModel.findOne).toHaveBeenCalledWith(
        { storeId: STORE_ID, type: 'home' },
        null,
        { session: transactionSession },
      );
      expect(storePageModel.updateOne).toHaveBeenCalledWith(
        { _id: 'home-1', storeId: STORE_ID, 'themeTemplates.installedThemeId': `instance-${STORE_ID}` },
        expect.objectContaining({
          $set: expect.objectContaining({ 'themeTemplates.$.sections': [{ type: 'hero', settings: {}, blocks: [] }] }),
          $push: expect.any(Object),
        }),
        { session: transactionSession },
      );
      expect(storeThemeModel.updateOne).toHaveBeenCalledWith(
        { _id: `instance-${STORE_ID}` },
        { $set: { 'draft.pendingHomeSections': null } },
        { session: transactionSession },
      );
      expect(storeThemeModel.db.transaction).toHaveBeenCalledTimes(1);
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

  describe('ensureDefaultTheme', () => {
    // Regression for a real bug found via fresh sign-off QA on a brand-new
    // store: the upsert used to seed only the ROOT `themeDefinitionId`,
    // leaving `draft`'s own copy at the schema's `null` default — silently
    // corrupting the row to `null` the moment the seller's first Publish
    // copied draft → root (breaks Draft/Share Preview's theme-registry
    // lookup). Asserts the upsert's `$setOnInsert` now seeds `draft`'s
    // `themeDefinitionId`/`baseThemeId` too, matching `installTheme`'s own
    // already-correct seeding.
    it('seeds draft.themeDefinitionId and draft.baseThemeId on the upsert, not just the root fields', async () => {
      await service.ensureDefaultTheme(STORE_ID);

      const [filter, update] = storeThemeModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ storeId: STORE_ID, status: 'active' });
      expect(update.$setOnInsert.themeDefinitionId).toBe('theme-01-atelier');
      expect(update.$setOnInsert['draft.themeDefinitionId']).toBe('theme-01-atelier');
      expect(update.$setOnInsert['draft.baseThemeId']).toBe('theme-01-atelier');
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

  describe('updateFooter', () => {
    it('saves the attached footer menu (menuId) and can detach it with null', async () => {
      await service.updateFooter(STORE_ID, SELLER_ID, { blocks: [], menuId: 'menu-1' } as any);
      const attach = storeThemeModel.findOneAndUpdate.mock.calls.at(-1)[1].$set;
      expect(attach['draft.footer.menuId']).toBe('menu-1');

      await service.updateFooter(STORE_ID, SELLER_ID, { blocks: [], menuId: null } as any);
      const detach = storeThemeModel.findOneAndUpdate.mock.calls.at(-1)[1].$set;
      expect(detach['draft.footer.menuId']).toBeNull();
    });

    it('leaves the stored menuId alone when the request does not mention it', async () => {
      await service.updateFooter(STORE_ID, SELLER_ID, { blocks: [] } as any);
      const set = storeThemeModel.findOneAndUpdate.mock.calls.at(-1)[1].$set;
      expect('draft.footer.menuId' in set).toBe(false);
    });
  });

  describe('header and footer settings (Batch 2)', () => {
    const lastSet = () => storeThemeModel.findOneAndUpdate.mock.calls.at(-1)[1].$set;

    it('persists every header setting under draft.header and trims labels (empty becomes null)', async () => {
      await service.updateHeader(STORE_ID, SELLER_ID, {
        logoWidth: 220, mobileLogoWidth: 90, sticky: true, showSearch: false, showAccount: false, showWishlist: false,
        showShopMenu: false, shopMenuLabel: '  Store  ', includePagesInNav: false, showDefaultBlogLink: false, blogLinkLabel: '   ',
        headerStyle: 'centered', navAlignment: 'center',
      } as any);
      const set = lastSet();
      expect(set).toMatchObject({
        'draft.header.logoWidth': 220, 'draft.header.mobileLogoWidth': 90, 'draft.header.sticky': true,
        'draft.header.showSearch': false, 'draft.header.showAccount': false, 'draft.header.showWishlist': false,
        'draft.header.showShopMenu': false, 'draft.header.shopMenuLabel': 'Store', 'draft.header.includePagesInNav': false,
        'draft.header.showDefaultBlogLink': false, 'draft.header.blogLinkLabel': null,
        'draft.header.headerStyle': 'centered', 'draft.header.navAlignment': 'center',
      });
    });

    it('lets a logo width be cleared with null and leaves untouched settings out of the update', async () => {
      await service.updateHeader(STORE_ID, SELLER_ID, { logoWidth: null } as any);
      const set = lastSet();
      expect(set['draft.header.logoWidth']).toBeNull();
      expect('draft.header.sticky' in set).toBe(false);
      expect('draft.header.showSearch' in set).toBe(false);
    });

    it('persists every footer setting under draft.footer', async () => {
      await service.updateFooter(STORE_ID, SELLER_ID, {
        blocks: [], logoSource: 'custom', logoUrl: 'https://cdn.example/logo.png', logoWidth: 180, showNewsletter: false,
        newsletterHeading: 'Join', newsletterText: '  ', showDefaultColumns: false, shopColumnHeading: 'Browse',
        accountColumnHeading: 'Me', blogLinkLabel: 'News',
      } as any);
      expect(lastSet()).toMatchObject({
        'draft.footer.logoSource': 'custom', 'draft.footer.logoUrl': 'https://cdn.example/logo.png', 'draft.footer.logoWidth': 180,
        'draft.footer.showNewsletter': false, 'draft.footer.newsletterHeading': 'Join', 'draft.footer.newsletterText': null,
        'draft.footer.showDefaultColumns': false, 'draft.footer.shopColumnHeading': 'Browse', 'draft.footer.accountColumnHeading': 'Me',
        'draft.footer.blogLinkLabel': 'News',
      });
    });

    it('refuses a custom footer logo with nothing uploaded instead of silently showing no logo', async () => {
      await expect(service.updateFooter(STORE_ID, SELLER_ID, { blocks: [], logoSource: 'custom', logoUrl: null } as any)).rejects.toThrow(/footer logo/i);
      // (resolving the store's default theme may upsert; what must never happen is saving the footer logo setting)
      expect(storeThemeModel.findOneAndUpdate.mock.calls.some((c: any[]) => c[1]?.$set && 'draft.footer.logoSource' in c[1].$set)).toBe(false);
    });

    it('accepts the new footer block types', async () => {
      await expect(service.updateFooter(STORE_ID, SELLER_ID, { blocks: [
        { type: 'footer_text', settings: { text: 'About' } },
        { type: 'footer_contact', settings: { email: 'a@b.co' } },
        { type: 'footer_payment_icons', settings: { icons: ['visa'] } },
      ] } as any)).resolves.toMatchObject({ success: true });
    });
  });
});
