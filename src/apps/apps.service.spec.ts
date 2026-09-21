/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppsService } from './apps.service';
import { DatabaseService } from '../database/databaseservice';
import { buildAppBlockType } from '../common/store-content/app-block.util';

const STORE_A = 'store-a';
const STORE_B = 'store-b';
const SELLER_A = 'seller-a';

describe('AppsService (Phase 8)', () => {
  let service: AppsService;
  let appInstallationModel: any;
  let storeModel: any;
  let storePageModel: any;
  let collectionTemplateModel: any;
  let db: DatabaseService;

  beforeEach(() => {
    storeModel = {
      findById: jest.fn().mockImplementation((id: string) => Promise.resolve({ _id: id, sellerId: SELLER_A, isDelete: false })),
    };
    appInstallationModel = {
      rows: [] as { storeId: string; appId: string }[],
      find: jest.fn().mockImplementation((filter: any) => ({
        lean: () => Promise.resolve(appInstallationModel.rows.filter((r: any) => r.storeId === filter.storeId)),
      })),
      findOneAndUpdate: jest.fn().mockImplementation((filter: any) => {
        if (!appInstallationModel.rows.some((r: any) => r.storeId === filter.storeId && r.appId === filter.appId)) {
          appInstallationModel.rows.push({ storeId: filter.storeId, appId: filter.appId });
        }
        return Promise.resolve();
      }),
      deleteOne: jest.fn().mockImplementation((filter: any) => {
        appInstallationModel.rows = appInstallationModel.rows.filter((r: any) => !(r.storeId === filter.storeId && r.appId === filter.appId));
        return Promise.resolve();
      }),
    };
    storePageModel = { find: jest.fn().mockResolvedValue([]) };
    collectionTemplateModel = { find: jest.fn().mockResolvedValue([]) };
    db = { repositories: { appInstallationModel, storeModel, storePageModel, collectionTemplateModel } } as unknown as DatabaseService;
    service = new AppsService(db);
  });

  it('lists the catalog with real per-store install state', async () => {
    const before = await service.listCatalogForStore(STORE_A, SELLER_A);
    expect(before.data.find(a => a.id === 'trust-signals')?.installed).toBe(false);

    await service.install(STORE_A, SELLER_A, 'trust-signals');
    const after = await service.listCatalogForStore(STORE_A, SELLER_A);
    expect(after.data.find(a => a.id === 'trust-signals')?.installed).toBe(true);
  });

  it('rejects installing an unknown app id', async () => {
    await expect(service.install(STORE_A, SELLER_A, 'does-not-exist')).rejects.toThrow();
  });

  it('is idempotent — installing an already-installed app does not duplicate the row', async () => {
    await service.install(STORE_A, SELLER_A, 'trust-signals');
    await service.install(STORE_A, SELLER_A, 'trust-signals');
    expect(appInstallationModel.rows.filter((r: any) => r.storeId === STORE_A && r.appId === 'trust-signals')).toHaveLength(1);
  });

  describe('assertBlocksAllowed — tenant isolation and section/settings enforcement', () => {
    const blockType = buildAppBlockType('trust-signals', 'rating_badge');
    const sectionWithAppBlock = (type = 'rich_text', settings: any = { text: 'Loved it', showStars: true }) => [
      { type, settings: {}, blocks: [{ type: blockType, settings }] },
    ];

    it('passes through untouched when there are no app blocks at all', async () => {
      await expect(service.assertBlocksAllowed(STORE_A, [{ type: 'hero', settings: {}, blocks: [] }])).resolves.toBeUndefined();
    });

    it('rejects a store that never installed the app (tenant isolation)', async () => {
      await expect(service.assertBlocksAllowed(STORE_A, sectionWithAppBlock())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a DIFFERENT store using the app installed only for store A', async () => {
      await service.install(STORE_A, SELLER_A, 'trust-signals');
      await expect(service.assertBlocksAllowed(STORE_B, sectionWithAppBlock())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the block once the app is installed for that exact store, in a supported section', async () => {
      await service.install(STORE_A, SELLER_A, 'trust-signals');
      await expect(service.assertBlocksAllowed(STORE_A, sectionWithAppBlock())).resolves.toBeUndefined();
    });

    it('rejects the same block in a section type the app does not support', async () => {
      await service.install(STORE_A, SELLER_A, 'trust-signals');
      await expect(service.assertBlocksAllowed(STORE_A, sectionWithAppBlock('hero'))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects invalid settings against the app block\'s own schema', async () => {
      await service.install(STORE_A, SELLER_A, 'trust-signals');
      await expect(service.assertBlocksAllowed(STORE_A, sectionWithAppBlock('rich_text', {}))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown app-block type', async () => {
      await service.install(STORE_A, SELLER_A, 'trust-signals');
      const sections = [{ type: 'rich_text', settings: {}, blocks: [{ type: 'app:trust-signals:no-such-block', settings: {} }] }];
      await expect(service.assertBlocksAllowed(STORE_A, sections)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('uninstall — real cleanup cascade', () => {
    const blockType = buildAppBlockType('trust-signals', 'rating_badge');

    it('strips only this app\'s blocks from every page/template, live and draft, and removes the install row', async () => {
      await service.install(STORE_A, SELLER_A, 'trust-signals');

      const page: any = {
        sections: [{ type: 'rich_text', blocks: [{ type: blockType, settings: {} }, { type: 'heading', settings: { text: 'Keep me' } }] }],
        draft: { sections: [{ type: 'rich_text', blocks: [{ type: blockType, settings: {} }] }] },
        save: jest.fn().mockResolvedValue(undefined),
      };
      storePageModel.find.mockResolvedValue([page]);

      const tpl: any = {
        sections: [{ type: 'rich_text', blocks: [{ type: blockType, settings: {} }] }],
        draft: { sections: [] },
        save: jest.fn().mockResolvedValue(undefined),
      };
      collectionTemplateModel.find.mockResolvedValue([tpl]);

      await service.uninstall(STORE_A, SELLER_A, 'trust-signals');

      expect(page.sections[0].blocks).toEqual([{ type: 'heading', settings: { text: 'Keep me' } }]);
      expect(page.draft.sections[0].blocks).toEqual([]);
      expect(page.save).toHaveBeenCalled();
      expect(tpl.sections[0].blocks).toEqual([]);
      expect(tpl.save).toHaveBeenCalled();
      expect(appInstallationModel.rows.find((r: any) => r.storeId === STORE_A && r.appId === 'trust-signals')).toBeUndefined();
    });

    it('never touches a document that has no app blocks (no unnecessary save)', async () => {
      await service.install(STORE_A, SELLER_A, 'trust-signals');
      const page: any = {
        sections: [{ type: 'hero', blocks: [] }],
        draft: { sections: [{ type: 'hero', blocks: [] }] },
        save: jest.fn().mockResolvedValue(undefined),
      };
      storePageModel.find.mockResolvedValue([page]);
      collectionTemplateModel.find.mockResolvedValue([]);

      await service.uninstall(STORE_A, SELLER_A, 'trust-signals');
      expect(page.save).not.toHaveBeenCalled();
    });
  });
});
