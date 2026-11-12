import { carrySections, draftOverLive, ThemeContentCarryService } from './theme-content-carry.service';

describe('carrySections', () => {
  const sections = [
    { type: 'hero' },
    { type: 'theme_section', settings: { sectionKey: 'maison.lookbook' } },
    { type: 'theme_section', settings: { sectionKey: 'tech.bento_grid' } },
    { type: 'rich_text' },
  ];

  it('keeps platform sections and only the target theme\'s own theme-defined sections', () => {
    const toTech = carrySections(sections, 'theme-04-tech');
    expect(toTech.kept.map(s => s.type + (s.settings?.sectionKey ?? ''))).toEqual(['hero', 'theme_sectiontech.bento_grid', 'rich_text']);
    expect(toTech.skipped).toBe(1);
    const toMaison = carrySections(sections, 'theme-03-fashion');
    expect(toMaison.kept.map(s => s.settings?.sectionKey ?? s.type)).toEqual(['hero', 'maison.lookbook', 'rich_text']);
  });

  it('drops every theme-defined section for a theme with no namespace', () => {
    expect(carrySections(sections, 'theme-99-new').kept.map(s => s.type)).toEqual(['hero', 'rich_text']);
  });

  it('handles missing input', () => {
    expect(carrySections(undefined, 'theme-04-tech')).toEqual({ kept: [], skipped: 0 });
  });
});

describe('draftOverLive', () => {
  const live = { ctaLabel: 'Shop', blocks: [{ type: 'nav_link' }], topBarEnabled: true };
  it('takes real unpublished edits', () => {
    expect(draftOverLive(live, { ctaLabel: 'Sale', blocks: [{ type: 'nav_link' }], topBarEnabled: false }, ['ctaLabel', 'blocks', 'topBarEnabled'])).toEqual({ ctaLabel: 'Sale', blocks: [{ type: 'nav_link' }], topBarEnabled: false });
  });
  it('follows live when the draft is empty, identical or missing', () => {
    expect(draftOverLive(live, { ctaLabel: null, blocks: [], topBarEnabled: true }, ['ctaLabel', 'blocks', 'topBarEnabled'])).toEqual(live);
    expect(draftOverLive(live, undefined, ['ctaLabel', 'blocks'])).toEqual({ ctaLabel: 'Shop', blocks: [{ type: 'nav_link' }] });
  });
});

describe('ThemeContentCarryService.carry', () => {
  const chain = (v: any) => ({ lean: () => Promise.resolve(v) });
  const make = () => {
    const source = { _id: 's1', storeId: 'st', themeDefinitionId: 'theme-03-fashion', status: 'active',
      header: { blocks: [{ type: 'nav_link' }], customLogoUrl: 'https://x/logo.png', headerStyle: 'split' },
      footer: { blocks: [{ type: 'copyright_text' }], footerStyle: 'minimal' },
      draft: { header: { blocks: [{ type: 'nav_link' }, { type: 'nav_link' }] } } };
    const target = { _id: 't1', storeId: 'st', themeDefinitionId: 'theme-04-tech', status: 'installed', header: {}, footer: {}, theme: {} };
    const themeUpdates: any[] = [];
    const themeModel = {
      findOne: jest.fn((q: any) => chain(q._id === 't1' ? target : (q._id === 's1' || q.status === 'active') ? source : null)),
      updateOne: jest.fn((f: any, u: any) => { themeUpdates.push(u); return Promise.resolve({}); }),
    };
    const pageUpdates: any[] = [];
    const pageModel = {
      find: jest.fn(() => chain([
        { _id: 'p1', type: 'home', sections: [{ type: 'hero' }], draft: { sections: [{ type: 'hero' }] }, themeTemplates: [
          { installedThemeId: 's1', sections: [{ type: 'hero' }, { type: 'theme_section', settings: { sectionKey: 'maison.lookbook' } }], draftSections: [{ type: 'hero' }] },
          { installedThemeId: 't1', sections: [{ type: 'old' }], draftSections: [] },
        ] },
        { _id: 'p2', type: 'custom', sections: [{ type: 'rich_text' }], draft: {}, themeTemplates: [] },
      ])),
      updateOne: jest.fn((f: any, u: any) => { pageUpdates.push({ f, u }); return Promise.resolve({}); }),
    };
    const created: any[] = [];
    const templateModel = {
      find: jest.fn(() => chain([{ resourceType: 'product', templateKey: 'default', name: 'Default', isDefault: true, sections: [{ type: 'product_main' }], draft: { sections: [{ type: 'product_main' }] }, status: 'published' }])),
      findOne: jest.fn(() => chain(null)),
      updateOne: jest.fn(),
      create: jest.fn((d: any) => { created.push(d); return Promise.resolve(d); }),
    };
    const svc = new ThemeContentCarryService({ repositories: { storeThemeModel: themeModel, storePageModel: pageModel, collectionTemplateModel: templateModel, storeModel: { findById: () => Promise.resolve({ sellerId: 'seller', isDelete: false }) } } } as any);
    return { svc, themeUpdates, pageUpdates, created, themeModel };
  };

  it('copies content, not design, and keeps a version of what it replaces', async () => {
    const { svc, themeUpdates, pageUpdates, created } = make();
    const res = await svc.carry('st', 'seller', 't1');
    expect(res.data).toEqual({ header: true, footer: true, pages: 2, templates: 1, skippedSections: 1 });
    const $set = themeUpdates[0].$set;
    expect($set['header.blocks']).toHaveLength(1);
    expect($set['draft.header.blocks']).toHaveLength(2);
    expect($set['header.customLogoUrl']).toBe('https://x/logo.png');
    expect($set['header.headerStyle'] === undefined).toBe(true);
    expect($set['footer.footerStyle'] === undefined).toBe(true);
    expect(themeUpdates[0].$push.versions.$each).toHaveLength(1);
    const home = pageUpdates[0];
    expect(home.u.$set['themeTemplates.$.sections']).toEqual([{ type: 'hero' }]);
    expect(home.u.$push['themeTemplates.$.versions'].$each[0].sections).toEqual([{ type: 'old' }]);
    expect(pageUpdates[1].u.$push.themeTemplates.sections).toEqual([{ type: 'rich_text' }]);
    expect([created[0].installedThemeId, created[0].resourceType, created[0].templateKey]).toEqual(['t1', 'product', 'default']);
  });

  it('refuses to copy a theme onto itself', async () => {
    const { svc } = make();
    await expect(svc.carry('st', 'seller', 't1', 't1')).rejects.toThrow();
  });
});
