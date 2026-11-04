/**
 * Real-MongoDB check of ThemeContentCarryService (real schemas + indexes). Local MongoDB only; drops its own database.
 *   MONGO_URI=mongodb://127.0.0.1:27091/theme_carry_e2e  (run from a folder WITHOUT the repo .env)
 *   NODE_OPTIONS=--max-old-space-size=6144 npx ts-node -r tsconfig-paths/register scripts/e2e-theme-carry-mongo.ts
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { StoreThemeSchema } from '../src/store-theme/schemas/store-theme.schema';
import { StorePageSchema } from '../src/store-pages/schemas/store-page.schema';
import { CollectionTemplateSchema } from '../src/collection-template/schemas/collection-template.schema';
import { ThemeContentCarryService } from '../src/store-theme/theme-content-carry.service';

const uri = process.env.MONGO_URI ?? '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) { console.error('Refusing: MONGO_URI must be local.'); process.exit(1); }

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra ? ' - ' + extra : '')); if (!ok) failed++; };

(async () => {
  const conn = await mongoose.createConnection(uri).asPromise();
  const storeThemeModel = conn.model('StoreTheme', StoreThemeSchema);
  const storePageModel = conn.model('StorePage', StorePageSchema);
  const collectionTemplateModel = conn.model('CollectionTemplate', CollectionTemplateSchema);
  const sellerId = new mongoose.Types.ObjectId().toString();
  const storeModel = { findById: async () => ({ sellerId, isDelete: false }) };
  const svc = new ThemeContentCarryService({ repositories: { storeThemeModel, storePageModel, collectionTemplateModel, storeModel } } as any);
  const storeId = new mongoose.Types.ObjectId().toString();
  try {
    const maison: any = await storeThemeModel.create({ storeId, themeDefinitionId: 'theme-03-fashion', status: 'active', baseThemeId: 'theme-03-fashion',
      header: { customLogoUrl: 'https://cdn/x.png', logoSource: 'custom', headerStyle: 'split', ctaLabel: 'Shop', blocks: [{ type: 'nav_link', settings: { label: 'Home' } }] },
      footer: { footerStyle: 'minimal', newsletterHeading: 'Join us', blocks: [{ type: 'copyright_text', settings: { text: '(c) Me' } }] } });
    const tech: any = await storeThemeModel.create({ storeId, themeDefinitionId: 'theme-04-tech', status: 'installed', baseThemeId: 'theme-04-tech',
      header: { headerStyle: 'standard', blocks: [] }, footer: { footerStyle: 'columns' } });
    const mId = String(maison._id), tId = String(tech._id);

    await storePageModel.create({ storeId, title: 'Home', slug: 'home', type: 'home', status: 'published', sections: [{ type: 'hero', settings: { heading: 'Legacy' }, blocks: [] }],
      themeTemplates: [
        { installedThemeId: mId, sections: [{ type: 'hero', settings: { heading: 'Maison hero' }, blocks: [] }, { type: 'theme_section', settings: { sectionKey: 'maison.lookbook' }, blocks: [] }, { type: 'rich_text', settings: { text: 'Hello' }, blocks: [] }], draftSections: [{ type: 'hero', settings: { heading: 'Maison draft' }, blocks: [] }] },
        { installedThemeId: tId, sections: [{ type: 'featured_products', settings: { heading: 'Tech starter' }, blocks: [] }], draftSections: [] },
      ] });
    await storePageModel.create({ storeId, title: 'About', slug: 'about', type: 'custom', status: 'published', sections: [{ type: 'rich_text', settings: { text: 'About us' }, blocks: [] }], themeTemplates: [] });
    await collectionTemplateModel.create({ storeId, installedThemeId: mId, resourceType: 'product', templateKey: 'default', name: 'Default', isDefault: true, status: 'published', sections: [{ type: 'product_main', settings: {}, blocks: [] }], draft: { sections: [{ type: 'product_main', settings: {}, blocks: [] }] } });

    const res: any = await svc.carry(storeId, sellerId, tId);
    check('result counts', res.data.pages === 2 && res.data.templates === 1 && res.data.header && res.data.footer, JSON.stringify(res.data));
    check('skipped the other theme\'s own section', res.data.skippedSections === 1);

    const t2: any = await storeThemeModel.findById(tId).lean();
    check('logo + nav + cta copied to live', t2.header.customLogoUrl === 'https://cdn/x.png' && t2.header.blocks.length === 1 && t2.header.ctaLabel === 'Shop');
    check('also copied to draft', t2.draft.header.customLogoUrl === 'https://cdn/x.png');
    check('header layout stays Tech\'s own', t2.header.headerStyle === 'standard' && t2.footer.footerStyle === 'columns');
    check('footer content copied', t2.footer.newsletterHeading === 'Join us' && t2.footer.blocks.length === 1);
    check('previous Tech look kept as a version', Array.isArray(t2.versions) && t2.versions.length === 1);
    const m2: any = await storeThemeModel.findById(mId).lean();
    check('source theme untouched', m2.header.headerStyle === 'split' && m2.status === 'active');

    const home: any = await storePageModel.findOne({ storeId, slug: 'home' }).lean();
    const ht = home.themeTemplates.find((x: any) => x.installedThemeId === tId);
    check('home page sections replaced with Maison\'s (minus foreign theme section)', ht.sections.length === 2 && ht.sections[0].settings.heading === "Maison hero" && ht.draftSections.length === 1 && ht.draftSections[0].settings.heading === "Maison draft");
    check('home page: old Tech sections kept as a version', ht.versions.length === 1 && ht.versions[0].sections[0].settings.heading === 'Tech starter');
    check('home page: Maison copy untouched', home.themeTemplates.find((x: any) => x.installedThemeId === mId).sections.length === 3);
    const about: any = await storePageModel.findOne({ storeId, slug: 'about' }).lean();
    const at = about.themeTemplates.find((x: any) => x.installedThemeId === tId);
    check('custom page without its own copy gets the legacy sections', at && at.sections.length === 1 && at.sections[0].settings.text === 'About us');
    const tpl: any = await collectionTemplateModel.findOne({ storeId, installedThemeId: tId, resourceType: 'product' }).lean();
    check('product template created for the target theme', tpl && tpl.sections.length === 1 && tpl.draft.sections.length === 1);

    // Back the other way (Tech -> Maison), proving it works in both directions.
    const back: any = await svc.carry(storeId, sellerId, mId, tId);
    check('works in the other direction too', back.data.pages === 2);
    const m3: any = await storeThemeModel.findById(mId).lean();
    check('Maison keeps its own look after copying back', m3.header.headerStyle === 'split');
    // Running twice must not duplicate anything.
    await svc.carry(storeId, sellerId, tId);
    const tplCount = await collectionTemplateModel.countDocuments({ storeId, installedThemeId: tId, resourceType: 'product' });
    check('running again does not duplicate templates', tplCount === 1);
  } catch (e) {
    failed++; console.error('ERROR', e);
  } finally {
    await conn.dropDatabase(); await conn.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})();
