/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as yauzl from 'yauzl';
import { Liquid } from 'liquidjs';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { readThemePackageStructure } from './theme-package-schema.util';
import { registerShopifyFilters, applyThemeSettingDefaults, applySectionSettingDefaults } from './liquid-shopify-filters.util';
import type { LiquidRenderCartItemDto } from './dto/render-liquid-theme.dto';

// Real-world Shopify themes (Dawn and premium themes) are several MiB with hundreds of files.
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 1500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const THEME_FOLDERS = new Set(['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates']);
const REQUIRED_FILES = new Set(['layout/theme.liquid', 'config/settings_schema.json', 'templates/index.json']);
const MAX_REVISIONS = 20;
const TEXT_EXTENSIONS = new Set(['.liquid', '.json', '.css', '.js', '.svg', '.txt', '.xml', '.html', '.map']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm']);

type PackageFile = { path: string; encoding: 'utf8' | 'base64'; content: string; size: number; sha256: string };

@Injectable()
export class ThemePackageService {
  constructor(private readonly db: DatabaseService) {}

  private get packages() { return this.db.repositories.themePackageModel; }
  private get themes() { return this.db.repositories.storeThemeModel; }
  private get stores() { return this.db.repositories.storeModel; }

  async upload(storeId: string, sellerId: string, installedThemeId: string, archive: Buffer) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    if (!archive?.length || archive.length > MAX_ARCHIVE_BYTES) throw new BadRequestException('Theme ZIP must be between 1 byte and 20 MiB.');
    if (archive.length < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b) throw new BadRequestException('Upload must be a ZIP archive.');
    const files = await readThemeZip(archive);
    validateThemePackage(files);
    return this.createRevision(storeId, installedThemeId, sellerId, files, 'upload');
  }

  async list(storeId: string, sellerId: string, installedThemeId: string) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const docs = await this.packages.find({ storeId, installedThemeId }).select('version changeType restoredFromVersion createdBy createdAt files.path files.size files.sha256').sort({ version: -1 }).lean();
    return { success: true, data: docs.map((d: any) => ({ ...d, files: d.files.map(({ path, size, sha256 }: any) => ({ path, size, sha256 })) })) };
  }

  async getRevision(storeId: string, sellerId: string, installedThemeId: string, version: number) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const doc = await this.packages.findOne({ storeId, installedThemeId, version }).lean();
    if (!doc) throw new NotFoundException('Theme source revision not found');
    return { success: true, data: doc };
  }

  async getStructure(storeId: string, sellerId: string, installedThemeId: string, version: number) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const revision = await this.packages.findOne({ storeId, installedThemeId, version }).lean();
    if (!revision) throw new NotFoundException('Theme source revision not found');
    try {
      return { success: true, data: { version, ...readThemePackageStructure(revision.files) } };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Theme package schema could not be read');
    }
  }

  async editFile(storeId: string, sellerId: string, installedThemeId: string, path: string, content: string) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const latest = await this.latest(storeId, installedThemeId);
    if (!latest) throw new NotFoundException('Upload a theme package before editing its source files');
    const normalizedPath = normalizePath(path);
    const existing = latest.files.find((file: any) => file.path === normalizedPath);
    if (!existing || existing.encoding !== 'utf8') throw new NotFoundException('Editable theme source file not found');
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new BadRequestException('Theme source file exceeds 2 MiB');
    const files = latest.files.map((file: any) => file.path === normalizedPath ? makeFile(normalizedPath, Buffer.from(content, 'utf8'), 'utf8') : file.toObject?.() ?? file);
    validateThemePackage(files);
    return this.createRevision(storeId, installedThemeId, sellerId, files, 'file_edit');
  }

  /** Edit code → "Add a new file": text (utf8) or binary asset (base64), inside a standard theme folder. */
  async addFile(storeId: string, sellerId: string, installedThemeId: string, path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8') {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const latest = await this.latest(storeId, installedThemeId);
    if (!latest) throw new NotFoundException('Upload a theme package before adding files');
    const normalizedPath = normalizePath(String(path ?? ''));
    const folder = normalizedPath.split('/')[0];
    if (!THEME_FOLDERS.has(folder) || normalizedPath.split('/').length < 2) throw new BadRequestException(`Files must live in one of: ${[...THEME_FOLDERS].join(', ')}`);
    const ext = extension(normalizedPath);
    const isText = TEXT_EXTENSIONS.has(ext);
    if (!isText && !BINARY_EXTENSIONS.has(ext)) throw new BadRequestException('This file type is not allowed in a theme');
    if (!isText && encoding !== 'base64') throw new BadRequestException('Binary theme files must be sent base64-encoded');
    if (typeof content !== 'string') throw new BadRequestException('File content is required');
    const data = Buffer.from(content, isText ? 'utf8' : 'base64');
    if (data.length > MAX_FILE_BYTES) throw new BadRequestException('Theme file exceeds 5 MiB');
    const existing = latest.files.map((f: any) => f.toObject?.() ?? f) as PackageFile[];
    if (existing.some((f) => f.path === normalizedPath)) throw new BadRequestException('A file with that name already exists');
    if (existing.length + 1 > MAX_FILES) throw new BadRequestException('Theme has too many files');
    const files = [...existing, makeFile(normalizedPath, data, isText ? 'utf8' : 'base64')];
    validateThemePackage(files);
    return this.createRevision(storeId, installedThemeId, sellerId, files, 'file_edit');
  }

  async deleteFile(storeId: string, sellerId: string, installedThemeId: string, path: string) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const latest = await this.latest(storeId, installedThemeId);
    if (!latest) throw new NotFoundException('Theme source not found');
    const normalizedPath = normalizePath(String(path ?? ''));
    if (REQUIRED_FILES.has(normalizedPath)) throw new BadRequestException(`${normalizedPath} is required by every theme and cannot be deleted`);
    const existing = latest.files.map((f: any) => f.toObject?.() ?? f) as PackageFile[];
    if (!existing.some((f) => f.path === normalizedPath)) throw new NotFoundException('Theme file not found');
    const files = existing.filter((f) => f.path !== normalizedPath);
    validateThemePackage(files);
    return this.createRevision(storeId, installedThemeId, sellerId, files, 'file_edit');
  }

  async renameFile(storeId: string, sellerId: string, installedThemeId: string, from: string, to: string) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const latest = await this.latest(storeId, installedThemeId);
    if (!latest) throw new NotFoundException('Theme source not found');
    const source = normalizePath(String(from ?? ''));
    const target = normalizePath(String(to ?? ''));
    if (REQUIRED_FILES.has(source)) throw new BadRequestException(`${source} is required by every theme and cannot be renamed`);
    if (!THEME_FOLDERS.has(target.split('/')[0]) || target.split('/').length < 2) throw new BadRequestException(`Files must live in one of: ${[...THEME_FOLDERS].join(', ')}`);
    if (extension(source) !== extension(target)) throw new BadRequestException('A file extension cannot be changed');
    const existing = latest.files.map((f: any) => f.toObject?.() ?? f) as PackageFile[];
    if (!existing.some((f) => f.path === source)) throw new NotFoundException('Theme file not found');
    if (existing.some((f) => f.path === target)) throw new BadRequestException('A file with that name already exists');
    const files = existing.map((f) => (f.path === source ? { ...f, path: target } : f));
    validateThemePackage(files);
    return this.createRevision(storeId, installedThemeId, sellerId, files, 'file_edit');
  }

  /** Back to the native (React) storefront: the active theme stops rendering from its Liquid source. Revisions are kept. */
  async unpublish(storeId: string, sellerId: string, installedThemeId: string) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    await this.themes.updateOne({ _id: installedThemeId, storeId }, { $set: { sourcePackageVersion: null } });
    return { success: true, message: 'Liquid source unpublished — the storefront uses the native theme again', data: { installedThemeId, version: null } };
  }

  /** Download a revision as a standard Shopify theme ZIP (no compression, hand-written — no extra dependency). */
  async exportZip(storeId: string, sellerId: string, installedThemeId: string, version?: number): Promise<{ filename: string; buffer: Buffer }> {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const revision = version === undefined || Number.isNaN(version)
      ? await this.latest(storeId, installedThemeId)
      : await this.packages.findOne({ storeId, installedThemeId, version });
    if (!revision) throw new NotFoundException('Theme source revision not found');
    const files = (revision.files as any[]).map((f) => ({ path: String(f.path), data: Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8') }));
    return { filename: `theme-v${revision.version}.zip`, buffer: buildStoredZip(files) };
  }

  async rollback(storeId: string, sellerId: string, installedThemeId: string, version: number) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const target = await this.packages.findOne({ storeId, installedThemeId, version }).lean();
    if (!target) throw new NotFoundException('Theme source revision not found');
    return this.createRevision(storeId, installedThemeId, sellerId, target.files as any, 'rollback', version);
  }

  /** `draft` lets the editor preview an UNSAVED edit: it replaces one text file in memory for this render only — nothing is persisted. */
  async preview(storeId: string, sellerId: string, installedThemeId: string, version?: number, path = '/', draft?: { path: string; content: string }) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const revision = version === undefined
      ? await this.latest(storeId, installedThemeId)
      : await this.packages.findOne({ storeId, installedThemeId, version });
    if (!revision) throw new NotFoundException('Upload a theme package before previewing it');
    const requestedPath = normalizeStorefrontPath(path);
    let files = revision.files as PackageFile[];
    if (draft && typeof draft.path === 'string' && typeof draft.content === 'string') {
      const draftPath = normalizePath(draft.path);
      if (Buffer.byteLength(draft.content, 'utf8') > MAX_FILE_BYTES) throw new BadRequestException('Theme source file exceeds 5 MiB');
      const target = files.find((f) => f.path === draftPath);
      if (!target || target.encoding !== 'utf8') throw new NotFoundException('Editable theme source file not found');
      files = files.map((f: any) => (f.path === draftPath ? makeFile(draftPath, Buffer.from(draft.content, 'utf8'), 'utf8') : (f.toObject?.() ?? f)));
    }
    const context = await this.getStorefrontContext(storeId, requestedPath, [], files);
    const html = await renderThemePreview(files as any[], context, requestedPath);
    return { success: true, data: { version: revision.version, html } };
  }

  async publish(storeId: string, sellerId: string, installedThemeId: string, version: number) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const revision = await this.packages.findOne({ storeId, installedThemeId, version }).select('_id version').lean();
    if (!revision) throw new NotFoundException('Theme source revision not found');
    await this.themes.updateMany({ storeId, _id: { $ne: installedThemeId } }, { $set: { status: 'installed' } });
    const published = await this.themes.findOneAndUpdate(
      { _id: installedThemeId, storeId },
      { $set: { status: 'active', sourcePackageVersion: version, lastPublishedAt: new Date() } },
      { new: true },
    ).select('_id sourcePackageVersion status');
    if (!published) throw new NotFoundException('Installed theme not found');
    return {
      success: true,
      message: `Theme source revision ${version} published`,
      data: { installedThemeId, version: published.sourcePackageVersion, status: published.status },
    };
  }

  async renderPublished(storeId: string, path: string, cartItems: LiquidRenderCartItemDto[] = []) {
    const requestedPath = normalizeStorefrontPath(path);
    const theme = await this.themes.findOne({ storeId, status: 'active', sourcePackageVersion: { $ne: null } })
      .select('_id sourcePackageVersion').lean();
    if (!theme || theme.sourcePackageVersion === null || theme.sourcePackageVersion === undefined) {
      throw new NotFoundException('This store does not have a published Liquid theme');
    }
    const revision = await this.packages.findOne({
      storeId, installedThemeId: String(theme._id), version: theme.sourcePackageVersion,
    }).lean();
    if (!revision) throw new NotFoundException('Published Liquid theme source is unavailable');
    const context = await this.getStorefrontContext(storeId, requestedPath, cartItems, revision.files as PackageFile[]);
    const html = await renderThemePreview(revision.files as any[], context, requestedPath);
    return { success: true, data: { html, version: theme.sourcePackageVersion } };
  }

  private async getStorefrontContext(
    storeId: string,
    path: string,
    requestedCartItems: LiquidRenderCartItemDto[] = [],
    themeFiles: PackageFile[] = [],
  ) {
    const {
      storeModel, productModel, productVariantModel, collectionModel, blogModel,
      blogPostModel, storePageModel,
    } = this.db.repositories;
    const store = await storeModel.findById(storeId)
      .select('name slug logo baseCurrency description tagline contactEmail contactPhone primaryDomain')
      .lean();
    if (!store) throw new NotFoundException('Store not found');
    const productFilter: Record<string, any> = { storeId, status: 'active', isDelete: false };
    const pageType = getPageType(path);
    const productSlug = routeSegment(path, 2);
    const searchTerms = pageType === 'search'
      // Liquid output is not auto-escaped (like Shopify), so a theme that prints `search.terms` raw would reflect
      // attacker HTML into the storefront frame — drop markup characters from the buyer-controlled query up front.
      ? (new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '').replace(/[<>"'`\u0000-\u001f]/g, '').trim().slice(0, 200)
      : '';

    const collections = await collectionModel.find({ storeId, status: 'active', isDelete: false })
      .select('_id name slug description image type productIds rules sortOrder templateKey')
      .sort({ sortOrder: 1, createdAt: -1 }).limit(100).lean();
    const collectionSlug = pageType === 'collection' ? routeSegment(path, 2) : undefined;
    const currentCollection = collectionSlug
      ? collections.find((collection: any) => collection.slug === collectionSlug)
      : undefined;
    const collectionPageSize = findPaginatePageSize(themeFiles, 'collection.products');
    let currentPage = getRequestedPage(path);
    const isPaginatedCollection = collectionPageSize !== null && pageType === 'collection';
    let collectionTotal = 0;
    let collectionProductFilter = productFilter;
    let manualCollectionIds: string[] | null = null;
    if (isPaginatedCollection) {
      if (collectionSlug === 'all') {
        collectionTotal = await productModel.countDocuments(productFilter);
      } else if (currentCollection?.type === 'manual') {
        manualCollectionIds = (currentCollection.productIds ?? []).map(String);
        const matchingIds = manualCollectionIds.length
          ? await productModel.find({ ...productFilter, _id: { $in: manualCollectionIds } }).distinct('_id')
          : [];
        const activeIds = new Set(matchingIds.map(String));
        manualCollectionIds = manualCollectionIds.filter((id) => activeIds.has(id));
        collectionTotal = manualCollectionIds.length;
      } else if (currentCollection) {
        collectionProductFilter = { ...productFilter, ...buildCollectionProductFilter(currentCollection.rules) };
        collectionTotal = await productModel.countDocuments(collectionProductFilter);
      } else {
        collectionProductFilter = { ...productFilter, _id: { $in: [] } };
      }
      currentPage = Math.min(currentPage, Math.max(1, Math.ceil(collectionTotal / collectionPageSize!)));
    }
    const isManualPaginatedCollection = isPaginatedCollection && currentCollection?.type === 'manual';
    const pagedManualIds = isManualPaginatedCollection
      ? (manualCollectionIds ?? []).slice((currentPage - 1) * collectionPageSize!, currentPage * collectionPageSize!)
      : null;
    let productQuery = productModel.find(isManualPaginatedCollection
      ? { ...productFilter, _id: { $in: pagedManualIds } }
      : isPaginatedCollection ? collectionProductFilter : productFilter)
      .select('_id name slug description type templateKey images tags categoryId subCategoryId averageRating totalRatings')
      .sort({ createdAt: -1 });
    if (isPaginatedCollection) {
      if (!isManualPaginatedCollection) productQuery = productQuery.skip((currentPage - 1) * collectionPageSize!).limit(collectionPageSize!);
    } else {
      productQuery = productQuery.limit(250);
    }
    let productRows = await productQuery.lean();
    if (isPaginatedCollection && manualCollectionIds) {
      const order = new Map(manualCollectionIds.map((id, index) => [id, index]));
      productRows = productRows.sort((a: any, b: any) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
    }
    const productIds = productRows.map((product: any) => String(product._id));
    const variants = productIds.length
      ? await productVariantModel.find({ productId: { $in: productIds }, isDelete: false })
        .select('_id productId price compareAtPrice options sku stock committedStock damagedStock inTransitStock unlimitedStock allowBackorder')
        .lean()
      : [];
    const variantsByProduct = new Map<string, any[]>();
    for (const variant of variants as any[]) {
      const key = String(variant.productId);
      variantsByProduct.set(key, [...(variantsByProduct.get(key) ?? []), variant]);
    }
    const products = productRows.map((product: any) => {
      const productVariants = variantsByProduct.get(String(product._id)) ?? [];
      const firstVariant = productVariants[0];
      const optionNames = [...new Set(productVariants.flatMap((variant: any) =>
        (variant.options ?? []).map((option: any) => option.name)).filter(Boolean))];
      const storefrontVariants = productVariants.map((variant: any) => ({
        id: String(variant._id),
        title: variant.options?.map((option: any) => option.value).join(' / ') || 'Default',
        price: Math.round(Number(variant.price) * 100),
        compare_at_price: variant.compareAtPrice == null ? null : Math.round(Number(variant.compareAtPrice) * 100),
        sku: variant.sku,
        available: variant.unlimitedStock || variant.allowBackorder || availableQuantity(variant) > 0,
        inventory_quantity: availableQuantity(variant),
        options: variant.options?.map((option: any) => option.value) ?? [],
        option1: variant.options?.[0]?.value ?? null,
        option2: variant.options?.[1]?.value ?? null,
        option3: variant.options?.[2]?.value ?? null,
      }));
      const selectedVariant = storefrontVariants.find((variant: any) => variant.available) ?? storefrontVariants[0] ?? null;
      const prices = productVariants.map((variant: any) => Number(variant.price)).filter(Number.isFinite);
      const compareAtPrices = productVariants.map((variant: any) => Number(variant.compareAtPrice))
        .filter((price: number) => Number.isFinite(price) && price > 0);
      return {
        id: String(product._id),
        type: product.type,
        templateKey: product.templateKey ?? 'default',
        title: product.name,
        handle: product.slug,
        description: product.description,
        description_html: product.description,
        url: `/products/${encodeURIComponent(product.slug ?? '')}`,
        options: optionNames,
        options_with_values: optionNames.map((name, index) => ({
          name, position: index + 1,
          values: [...new Set(productVariants.flatMap((variant: any) =>
            (variant.options ?? []).filter((option: any) => option.name === name).map((option: any) => option.value)))],
        })),
        has_only_default_variant: optionNames.length === 0,
        selected_or_first_available_variant: selectedVariant,
        first_available_variant: storefrontVariants.find((variant: any) => variant.available) ?? null,
        available: productVariants.some((variant: any) => variant.unlimitedStock || variant.allowBackorder || availableQuantity(variant) > 0),
        price: Math.round(Math.min(...(prices.length ? prices : [Number(firstVariant?.price ?? 0)])) * 100),
        price_min: Math.round(Math.min(...(prices.length ? prices : [0])) * 100),
        price_max: Math.round(Math.max(...(prices.length ? prices : [0])) * 100),
        compare_at_price: compareAtPrices.length ? Math.round(Math.min(...compareAtPrices) * 100) : null,
        featured_image: product.images?.[0] ? { src: product.images[0], alt: product.name } : null,
        images: (product.images ?? []).map((src: string) => ({ src, alt: product.name })),
        tags: product.tags ?? [],
        variants: storefrontVariants,
        rating: product.averageRating ?? 0,
        rating_count: product.totalRatings ?? 0,
      };
    });
    const currentProduct = pageType === 'product'
      ? products.find((product) => product.handle === productSlug)
      : undefined;
    const collectionProducts = collections.map((collection: any) => {
      const ids = collection.type === 'manual'
        ? collection.productIds ?? []
        : products.filter((product) => productMatchesCollection(product, collection.rules)).map((product) => product.id);
      const matchingProducts = products.filter((product) => ids.includes(product.id));
      if (collection.type === 'manual') {
        const order = new Map<string, number>(ids.map((id: string, index: number) => [id, index]));
        matchingProducts.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
      }
      return {
        id: String(collection._id), title: collection.name, handle: collection.slug,
        template_suffix: collection.templateKey && collection.templateKey !== 'default' ? collection.templateKey : '',
        templateKey: collection.templateKey ?? 'default',
        description: collection.description ?? '', url: `/collections/${encodeURIComponent(collection.slug)}`,
        image: collection.image ? { src: collection.image, alt: collection.name } : null,
        products: matchingProducts,
        products_count: isPaginatedCollection && collection.slug === collectionSlug ? collectionTotal : matchingProducts.length,
        all_products_count: isPaginatedCollection && collection.slug === collectionSlug ? collectionTotal : matchingProducts.length,
      };
    });
    const currentCollectionObject = currentCollection
      ? collectionProducts.find((collection: any) => collection.handle === currentCollection.slug)
      : undefined;
    const allProductsCollection = collectionSlug === 'all' ? {
      id: 'all', title: 'All products', handle: 'all', description: '',
      url: '/collections/all', image: null, products,
      products_count: isPaginatedCollection ? collectionTotal : products.length,
      all_products_count: isPaginatedCollection ? collectionTotal : products.length,
    } : undefined;
    const searchResults = searchTerms
      ? products.filter((product) => {
        const query = searchTerms.toLocaleLowerCase();
        return product.title.toLocaleLowerCase().includes(query)
          || product.description.toLocaleLowerCase().includes(query)
          || product.tags.some((tag: string) => tag.toLocaleLowerCase().includes(query));
      })
      : [];
    const pageSlug = pageType === 'page' ? routeSegment(path, path.startsWith('/pages/') ? 2 : 1) : undefined;
    const pageRow = pageSlug
      ? await storePageModel.findOne({ storeId, slug: pageSlug, type: 'custom', status: 'published', isDelete: false })
        .select('title slug sections').lean()
      : null;
    const blogs = await blogModel.find({ storeId, isDelete: false })
      .select('_id title slug commentsEnabled createdAt').sort({ createdAt: 1 }).limit(100).lean();
    const blogSlug = pageType === 'blog' || pageType === 'article'
      ? (path.startsWith('/blog/') ? undefined : routeSegment(path, 2))
      : undefined;
    const currentBlog: any = blogSlug
      ? blogs.find((blog: any) => blog.slug === blogSlug)
      : blogs[0];
    const articleSlug = pageType === 'article'
      ? (path.startsWith('/blog/') ? routeSegment(path, 2) : routeSegment(path, 3))
      : undefined;
    const articleRow = articleSlug && currentBlog
      ? await blogPostModel.findOne({
        storeId, blogId: String(currentBlog._id), slug: articleSlug, status: 'published', isDelete: false,
      }).select('title slug excerpt coverImage authorName tags publishedAt content').lean()
      : null;
    const articleContent = articleRow ? renderBlogContent(articleRow.content ?? []) : '';
    const article = articleRow ? {
      id: String(articleRow._id), title: articleRow.title, handle: articleRow.slug,
      excerpt: articleRow.excerpt ?? '', content: articleContent,
      content_html: articleContent,
      image: articleRow.coverImage ? { src: articleRow.coverImage, alt: articleRow.title } : null,
      author: articleRow.authorName ?? '', tags: articleRow.tags ?? [], published_at: articleRow.publishedAt,
      url: `/blogs/${encodeURIComponent(currentBlog.slug)}/${encodeURIComponent(articleRow.slug)}`,
      blog: { title: currentBlog.title, handle: currentBlog.slug, url: `/blogs/${encodeURIComponent(currentBlog.slug)}` },
    } : null;
    const blogPosts = pageType === 'blog' && currentBlog
      ? await blogPostModel.find({
        storeId, blogId: String(currentBlog._id), status: 'published', isDelete: false,
      }).select('title slug excerpt coverImage authorName publishedAt').sort({ publishedAt: -1 }).limit(50).lean()
      : [];
    const page = pageRow ? {
      id: String(pageRow._id), title: pageRow.title, handle: pageRow.slug,
      url: `/pages/${encodeURIComponent(pageRow.slug)}`,
      content: renderPageContent(pageRow.sections ?? []),
      content_html: renderPageContent(pageRow.sections ?? []),
    } : {
      title: article?.title ?? currentCollectionObject?.title ?? currentProduct?.title ?? store.name,
      url: path,
    };
    const resolvedCart = await this.resolveLiquidCart(storeId, requestedCartItems);
    const currency = store.baseCurrency || 'USD';
    const storeOrigin = `https://${store.primaryDomain || `${store.slug}.solvexo.store`}`;
    return {
      shop: {
        name: store.name,
        url: storeOrigin,
        domain: store.primaryDomain || `${store.slug}.solvexo.store`,
        currency,
        description: store.description ?? store.tagline ?? '',
        email: store.contactEmail ?? '',
        phone: store.contactPhone ?? '',
        money_format: `{{amount}} ${currency}`,
      },
      request: { page_type: pageType, origin: storeOrigin, path },
      page,
      product: currentProduct ?? null,
      collection: currentCollectionObject ?? allProductsCollection ?? null,
      blog: currentBlog ? {
        id: String(currentBlog._id), title: currentBlog.title, handle: currentBlog.slug,
        url: `/blogs/${encodeURIComponent(currentBlog.slug)}`, comments_enabled: currentBlog.commentsEnabled,
        articles: blogPosts.map((post: any) => ({
          id: String(post._id), title: post.title, handle: post.slug, excerpt: post.excerpt ?? '',
          author: post.authorName ?? '', published_at: post.publishedAt,
          image: post.coverImage ? { src: post.coverImage, alt: post.title } : null,
          url: `/blogs/${encodeURIComponent(currentBlog.slug)}/${encodeURIComponent(post.slug)}`,
        })),
      } : null,
      article,
      products: { featured: products[0] ?? null, ...Object.fromEntries(products.map((product) => [product.handle, product])) },
      collections: { all: collectionProducts },
      search: {
        terms: searchTerms,
        performed: getPageType(path) === 'search' && searchTerms.length > 0,
        results: { products: searchResults, count: searchResults.length },
      },
      cart: resolvedCart,
      paginate: isPaginatedCollection
        ? buildShopifyPagination(collectionTotal, collectionPageSize!, currentPage, path)
        : {},
      routes: {
        root_url: '/', cart_url: '/cart', search_url: '/search', account_url: '/account',
        products_url: '/products', collections_url: '/collections', all_products_collection_url: '/collections/all',
        account_login_url: '/login', account_register_url: '/register', cart_add_url: '/cart/add',
      },
      __storefront: { storeId, path, products },
      __resources: await this.getLiquidResources(storeId, themeFiles),
      __storefrontOrigin: storeOrigin,
    };
  }

  private async getLiquidResources(storeId: string, themeFiles: PackageFile[]) {
    const ids = collectLiquidResourceIds(themeFiles);
    if (!ids.length) return {};
    const { productModel, productVariantModel, collectionModel, storePageModel, blogModel, blogPostModel, menuModel } = this.db.repositories;
    const [products, collections, pages, blogs, articles, menus] = await Promise.all([
      productModel.find({ _id: { $in: ids }, storeId, status: 'active', isDelete: false })
        .select('_id name slug description type images tags').lean(),
      collectionModel.find({ _id: { $in: ids }, storeId, status: 'active', isDelete: false })
        .select('_id name slug description image productIds').lean(),
      storePageModel.find({ _id: { $in: ids }, storeId, type: 'custom', status: 'published', isDelete: false })
        .select('_id title slug sections').lean(),
      blogModel.find({ _id: { $in: ids }, storeId, isDelete: false })
        .select('_id title slug commentsEnabled').lean(),
      blogPostModel.find({ _id: { $in: ids }, storeId, status: 'published', isDelete: false })
        .select('_id blogId title slug excerpt coverImage authorName tags publishedAt content').lean(),
      menuModel.find({ _id: { $in: ids }, storeId })
        .select('_id name items').lean(),
    ]);
    const selectedArticleBlogIds = [...new Set((articles as any[]).map((article) => String(article.blogId)).filter(Boolean))];
    const relatedBlogs = selectedArticleBlogIds.length
      ? await blogModel.find({ _id: { $in: selectedArticleBlogIds }, storeId, isDelete: false })
        .select('_id title slug commentsEnabled').lean()
      : [];
    const allBlogs = [...new Map([...blogs as any[], ...relatedBlogs as any[]].map((blog: any) => [String(blog._id), blog])).values()];
    const blogIds = (allBlogs as any[]).map((blog) => String(blog._id));
    const blogArticles = blogIds.length
      ? await blogPostModel.find({ storeId, blogId: { $in: blogIds }, status: 'published', isDelete: false })
        .select('_id blogId title slug excerpt coverImage authorName tags publishedAt content')
        .sort({ publishedAt: -1 }).limit(100).lean()
      : [];
    const allArticles = [...new Map([...articles as any[], ...blogArticles as any[]].map((article: any) => [String(article._id), article])).values()];
    const variants = products.length
      ? await productVariantModel.find({ productId: { $in: products.map((product: any) => String(product._id)) }, isDelete: false, status: 'active' })
        .select('_id productId price compareAtPrice options sku stock committedStock damagedStock inTransitStock unlimitedStock allowBackorder').lean()
      : [];
    const variantsByProduct = new Map<string, any[]>();
    for (const variant of variants as any[]) {
      const productId = String(variant.productId);
      variantsByProduct.set(productId, [...(variantsByProduct.get(productId) ?? []), variant]);
    }
    const resourceMap: Record<string, any> = {};
    for (const product of products as any[]) {
      const productVariants = variantsByProduct.get(String(product._id)) ?? [];
      const mappedVariants = productVariants.map((variant) => ({
        id: String(variant._id), title: variant.options?.map((option: any) => option.value).join(' / ') || 'Default',
        price: Math.round(Number(variant.price) * 100),
        compare_at_price: variant.compareAtPrice == null ? null : Math.round(Number(variant.compareAtPrice) * 100),
        sku: variant.sku,
        available: variant.unlimitedStock || variant.allowBackorder || availableQuantity(variant) > 0,
        inventory_quantity: availableQuantity(variant),
        options: variant.options?.map((option: any) => option.value) ?? [],
        option1: variant.options?.[0]?.value ?? null, option2: variant.options?.[1]?.value ?? null,
        option3: variant.options?.[2]?.value ?? null,
      }));
      const prices = productVariants.map((variant) => Number(variant.price)).filter(Number.isFinite);
      resourceMap[String(product._id)] = {
        id: String(product._id), title: product.name, handle: product.slug,
        description: product.description ?? '', description_html: product.description ?? '',
        url: `/products/${encodeURIComponent(product.slug ?? '')}`,
        price: Math.round(Math.min(...(prices.length ? prices : [0])) * 100),
        price_min: Math.round(Math.min(...(prices.length ? prices : [0])) * 100),
        price_max: Math.round(Math.max(...(prices.length ? prices : [0])) * 100),
        available: mappedVariants.some((variant) => variant.available),
        variants: mappedVariants,
        selected_or_first_available_variant: mappedVariants.find((variant) => variant.available) ?? mappedVariants[0] ?? null,
        first_available_variant: mappedVariants.find((variant) => variant.available) ?? null,
        featured_image: product.images?.[0] ? { src: product.images[0], alt: product.name } : null,
        images: (product.images ?? []).map((src: string) => ({ src, alt: product.name })),
        tags: product.tags ?? [],
      };
    }
    const linkedProductIds = [...new Set((collections as any[]).flatMap((collection) => collection.productIds ?? []).map(String))]
      .filter((id) => /^[a-f\d]{24}$/i.test(id) && !products.some((product: any) => String(product._id) === id));
    const [linkedProducts, automaticCollectionProducts] = await Promise.all([
      linkedProductIds.length
      ? await productModel.find({ _id: { $in: linkedProductIds }, storeId, status: 'active', isDelete: false })
        .select('_id name slug description type images tags').lean()
      : [],
      Promise.all((collections as any[]).filter((collection) => collection.type === 'automatic').map((collection) =>
        productModel.find({ storeId, status: 'active', isDelete: false, ...buildCollectionProductFilter(collection.rules) })
          .select('_id name slug description type images tags').limit(250).lean(),
      )),
    ]);
    const additionalProducts = [...new Map(
      [...linkedProducts as any[], ...automaticCollectionProducts.flat()]
        .filter((product: any) => !products.some((existing: any) => String(existing._id) === String(product._id)))
        .map((product: any) => [String(product._id), product]),
    ).values()];
    if (additionalProducts.length) {
      const linkedVariants = await productVariantModel.find({ productId: { $in: additionalProducts.map((product: any) => String(product._id)) }, isDelete: false, status: 'active' })
        .select('_id productId price compareAtPrice options sku stock committedStock damagedStock inTransitStock unlimitedStock allowBackorder').lean();
      for (const variant of linkedVariants as any[]) {
        const productId = String(variant.productId);
        variantsByProduct.set(productId, [...(variantsByProduct.get(productId) ?? []), variant]);
      }
      for (const product of additionalProducts as any[]) {
        const productVariants = variantsByProduct.get(String(product._id)) ?? [];
        const mappedVariants = productVariants.map((variant) => ({
          id: String(variant._id), title: variant.options?.map((option: any) => option.value).join(' / ') || 'Default',
          price: Math.round(Number(variant.price) * 100),
          compare_at_price: variant.compareAtPrice == null ? null : Math.round(Number(variant.compareAtPrice) * 100),
          sku: variant.sku, available: variant.unlimitedStock || variant.allowBackorder || availableQuantity(variant) > 0,
          inventory_quantity: availableQuantity(variant), options: variant.options?.map((option: any) => option.value) ?? [],
        }));
        const prices = productVariants.map((variant) => Number(variant.price)).filter(Number.isFinite);
        resourceMap[String(product._id)] = {
          id: String(product._id), title: product.name, handle: product.slug,
          description: product.description ?? '', description_html: product.description ?? '',
          url: `/products/${encodeURIComponent(product.slug ?? '')}`,
          price: Math.round(Math.min(...(prices.length ? prices : [0])) * 100),
          price_min: Math.round(Math.min(...(prices.length ? prices : [0])) * 100),
          price_max: Math.round(Math.max(...(prices.length ? prices : [0])) * 100),
          available: mappedVariants.some((variant) => variant.available), variants: mappedVariants,
          selected_or_first_available_variant: mappedVariants.find((variant) => variant.available) ?? mappedVariants[0] ?? null,
          first_available_variant: mappedVariants.find((variant) => variant.available) ?? null,
          featured_image: product.images?.[0] ? { src: product.images[0], alt: product.name } : null,
          images: (product.images ?? []).map((src: string) => ({ src, alt: product.name })), tags: product.tags ?? [],
        };
      }
    }
    for (const collection of collections as any[]) {
      const linkedProducts = (collection.productIds ?? [])
        .map((id: string) => resourceMap[String(id)])
        .filter(Boolean);
      resourceMap[String(collection._id)] = {
        id: String(collection._id), title: collection.name, handle: collection.slug,
        description: collection.description ?? '', url: `/collections/${encodeURIComponent(collection.slug)}`,
        image: collection.image ? { src: collection.image, alt: collection.name } : null,
        products: linkedProducts, products_count: linkedProducts.length, all_products_count: linkedProducts.length,
      };
    }
    for (const page of pages as any[]) {
      const content = renderPageContent(page.sections ?? []);
      resourceMap[String(page._id)] = { id: String(page._id), title: page.title, handle: page.slug, url: `/pages/${encodeURIComponent(page.slug)}`, content, content_html: content };
    }
    const articleBlogById = new Map((allBlogs as any[]).map((blog) => [String(blog._id), blog]));
    const articlesByBlog = new Map<string, any[]>();
    for (const article of allArticles as any[]) {
      const blog = articleBlogById.get(String(article.blogId));
      const articleResource = {
        id: String(article._id), title: article.title, handle: article.slug,
        excerpt: article.excerpt ?? '', content: renderBlogContent(article.content ?? []),
        content_html: renderBlogContent(article.content ?? []),
        image: article.coverImage ? { src: article.coverImage, alt: article.title } : null,
        author: article.authorName ?? '', tags: article.tags ?? [], published_at: article.publishedAt,
        url: `/blogs/${encodeURIComponent(blog?.slug ?? String(article.blogId))}/${encodeURIComponent(article.slug)}`,
        blog: blog ? { id: String(blog._id), title: blog.title, handle: blog.slug, url: `/blogs/${encodeURIComponent(blog.slug)}` } : null,
      };
      resourceMap[String(article._id)] = articleResource;
      const blogId = String(article.blogId);
      articlesByBlog.set(blogId, [...(articlesByBlog.get(blogId) ?? []), articleResource]);
    }
    for (const blog of allBlogs as any[]) {
      resourceMap[String(blog._id)] = {
        id: String(blog._id), title: blog.title, handle: blog.slug,
        url: `/blogs/${encodeURIComponent(blog.slug)}`, comments_enabled: blog.commentsEnabled,
        articles: articlesByBlog.get(String(blog._id)) ?? [],
      };
    }
    for (const menu of menus as any[]) {
      resourceMap[String(menu._id)] = {
        id: String(menu._id), title: menu.name, handle: String(menu.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        links: (menu.items ?? []).map((item: any) => toLiquidMenuLink(item, resourceMap)),
      };
    }
    return resourceMap;
  }

  private async resolveLiquidCart(storeId: string, requestedItems: LiquidRenderCartItemDto[]) {
    const distinctItems = [...new Map(
      requestedItems.map((item) => [`${item.productId}:${item.productVariantId}`, item]),
    ).values()];
    if (!distinctItems.length) return { item_count: 0, total_price: 0, items: [] };

    const productIds = [...new Set(distinctItems.map((item) => item.productId))];
    const variantIds = distinctItems.map((item) => item.productVariantId);
    const [products, variants] = await Promise.all([
      this.db.repositories.productModel.find({ _id: { $in: productIds }, storeId, status: 'active', isDelete: false })
        .select('_id name slug type images').lean(),
      this.db.repositories.productVariantModel.find({
        _id: { $in: variantIds }, productId: { $in: productIds }, isDelete: false, status: 'active',
      }).select('_id productId price compareAtPrice options sku').lean(),
    ]);
    const productsById = new Map(products.map((product: any) => [String(product._id), product]));
    const variantsById = new Map(variants.map((variant: any) => [String(variant._id), variant]));
    const items = distinctItems.flatMap((requested) => {
      const product: any = productsById.get(requested.productId);
      const variant: any = variantsById.get(requested.productVariantId);
      if (!product || !variant || String(variant.productId) !== requested.productId) return [];
      const unitPrice = Math.round(Number(variant.price) * 100);
      return [{
        id: String(variant._id),
        key: String(variant._id),
        product_id: String(product._id),
        variant_id: String(variant._id),
        product: {
          id: String(product._id), title: product.name, handle: product.slug,
          url: `/products/${encodeURIComponent(product.slug ?? "")}`,
          featured_image: product.images?.[0] ? { src: product.images[0], alt: product.name } : null,
        },
        variant: {
          id: String(variant._id), title: variant.options?.map((option: any) => option.value).join(' / ') || 'Default',
          sku: variant.sku, price: unitPrice,
        },
        title: product.name,
        quantity: requested.quantity,
        price: unitPrice,
        original_price: unitPrice,
        final_price: unitPrice,
        line_price: unitPrice * requested.quantity,
        final_line_price: unitPrice * requested.quantity,
        image: product.images?.[0] ?? null,
        url: `/products/${encodeURIComponent(product.slug ?? "")}`,
        product_type: product.type,
      }];
    });
    return {
      item_count: items.reduce((count, item) => count + item.quantity, 0),
      total_price: items.reduce((total, item) => total + item.final_line_price, 0),
      items,
    };
  }

  private async assertInstalledTheme(storeId: string, installedThemeId: string) {
    const theme = await this.themes.findOne({ _id: installedThemeId, storeId }).select('_id').lean();
    if (!theme) throw new NotFoundException('Installed theme not found');
  }

  private async latest(storeId: string, installedThemeId: string) {
    return this.packages.findOne({ storeId, installedThemeId }).sort({ version: -1 });
  }

  private async createRevision(storeId: string, installedThemeId: string, createdBy: string, files: PackageFile[], changeType: 'upload' | 'file_edit' | 'rollback', restoredFromVersion: number | null = null) {
    let doc: any;
    let version = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await this.packages.findOne({ storeId, installedThemeId }).select('version').sort({ version: -1 }).lean() as any;
      version = (previous?.version ?? 0) + 1;
      try {
        doc = await this.packages.create({ storeId, installedThemeId, version, createdBy, changeType, restoredFromVersion, files });
        break;
      } catch (error: any) {
        if (error?.code !== 11000 || attempt === 2) throw error;
      }
    }
    if (!doc) throw new BadRequestException('Could not create a unique source revision; please retry.');
    // Never prune the revision the live storefront renders from — otherwise 20 edits after publishing take the store down.
    const live = await this.themes.findOne({ _id: installedThemeId, storeId }).select('sourcePackageVersion').lean() as any;
    const pruneFilter: Record<string, any> = { storeId, installedThemeId, version: { $lte: version - MAX_REVISIONS } };
    if (typeof live?.sourcePackageVersion === 'number') pruneFilter.version.$ne = live.sourcePackageVersion;
    await this.packages.deleteMany(pruneFilter);
    return { success: true, message: changeType === 'rollback' ? `Theme source restored as revision ${version}` : `Theme source saved as revision ${version}`, data: { version: doc.version, changeType: doc.changeType, restoredFromVersion: doc.restoredFromVersion, files: doc.files.map(({ path, size, sha256 }: any) => ({ path, size, sha256 })) } };
  }
}

async function readThemeZip(buffer: Buffer): Promise<PackageFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (openError, zip) => {
      if (openError || !zip) return reject(new BadRequestException('Could not read the theme ZIP archive'));
      const files: PackageFile[] = [];
      let expandedBytes = 0;
      let finished = false;
      const fail = (message: string) => { if (finished) return; finished = true; zip.close(); reject(new BadRequestException(message)); };
      zip.on('error', () => fail('Theme ZIP is malformed'));
      zip.on('end', () => {
        if (finished) return;
        finished = true;
        try { resolve(stripCommonRoot(files)); } catch (error: any) { reject(error); }
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        if (/(^|\/)(\.DS_Store|__MACOSX)(\/|$)/i.test(entry.fileName)) return zip.readEntry();
        if (files.length >= MAX_FILES) return fail(`Theme ZIP cannot contain more than ${MAX_FILES} files`);
        let path: string;
        try { path = normalizePath(entry.fileName); } catch { return fail('Theme ZIP contains an unsafe file path'); }
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return fail('Symbolic links are not allowed in theme ZIPs');
        if (files.some((file) => file.path.toLowerCase() === path.toLowerCase())) return fail(`Duplicate theme file path: ${path}`);
        if (entry.uncompressedSize > MAX_FILE_BYTES) return fail(`Theme file exceeds 2 MiB: ${path}`);
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > MAX_EXPANDED_BYTES) return fail('Uncompressed theme package exceeds 8 MiB');
        const ext = extension(path);
        if (!TEXT_EXTENSIONS.has(ext) && !BINARY_EXTENSIONS.has(ext)) return fail(`Unsupported file in theme package: ${path}`);
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(`Could not read theme file: ${path}`);
          const chunks: Buffer[] = [];
          let bytes = 0;
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_FILE_BYTES || expandedBytes - entry.uncompressedSize + bytes > MAX_EXPANDED_BYTES) return fail('Theme ZIP expands beyond the allowed size');
            chunks.push(chunk);
          });
          stream.on('error', () => fail(`Theme file is corrupt: ${path}`));
          stream.on('end', () => {
            if (finished) return;
            const data = Buffer.concat(chunks);
            files.push(makeFile(path, data, TEXT_EXTENSIONS.has(ext) ? 'utf8' : 'base64'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function validateThemePackage(files: PackageFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const required of ['layout/theme.liquid', 'config/settings_schema.json', 'templates/index.json']) {
    if (!byPath.has(required)) throw new BadRequestException(`Theme ZIP is missing required file: ${required}`);
  }
  for (const path of ['config/settings_schema.json', 'templates/index.json']) {
    try { JSON.parse(String(byPath.get(path)!.content)); } catch { throw new BadRequestException(`Theme package contains invalid JSON: ${path}`); }
  }
  const settingsSchema = JSON.parse(String(byPath.get('config/settings_schema.json')!.content));
  const indexTemplate = JSON.parse(String(byPath.get('templates/index.json')!.content));
  if (!Array.isArray(settingsSchema)) throw new BadRequestException('config/settings_schema.json must contain a JSON array');
  if (!indexTemplate || typeof indexTemplate !== 'object' || !indexTemplate.sections || !Array.isArray(indexTemplate.order)) {
    throw new BadRequestException('templates/index.json must define section objects and an ordered section list');
  }
  if (indexTemplate.order.some((key: unknown) => typeof key !== 'string' || !(key in indexTemplate.sections))) {
    throw new BadRequestException('templates/index.json order contains a missing section key');
  }
  try {
    readThemePackageStructure(files);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'Theme package schema is invalid');
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** Minimal ZIP writer (method 0 = stored). Themes are mostly already-compressed assets plus small text, so this is fine. */
function buildStoredZip(entries: { path: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const name = Buffer.from(path, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function normalizePath(input: string): string {
  const path = input.replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.' || !part)) throw new BadRequestException('Theme file path is unsafe');
  if (path.split('/').length > 12 || path.length > 240 || /(^|\/)(\.git|node_modules)(\/|$)/i.test(path)) throw new BadRequestException('Theme file path is not allowed');
  return path;
}

function stripCommonRoot(files: PackageFile[]): PackageFile[] {
  if (!files.length) throw new BadRequestException('Theme ZIP is empty');
  const first = files[0].path.split('/')[0];
  if (files.every((file) => file.path.startsWith(`${first}/`))) return files.map((file) => ({ ...file, path: normalizePath(file.path.slice(first.length + 1)) }));
  return files;
}

function extension(path: string): string { return path.slice(path.lastIndexOf('.')).toLowerCase(); }
function makeFile(path: string, data: Buffer, encoding: 'utf8' | 'base64'): PackageFile {
  return { path, encoding, content: data.toString(encoding), size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

export { buildStoredZip };

export async function renderThemePreview(files: PackageFile[], contextOverrides: Record<string, any> = {}, requestedPath = '/'): Promise<string> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const textTemplates = Object.fromEntries(files.filter((file) => file.encoding === 'utf8').map((file) => [file.path, file.content]));
  let settings: Record<string, any> = {};
  let staticSections: Record<string, any> = {};
  try {
    const data = JSON.parse(byPath.get('config/settings_data.json')?.content ?? '{}');
    // `current` may be a preset NAME (string) pointing into `presets` — resolve it instead of exposing a string as `settings`.
    const current = typeof data.current === 'string' ? data.presets?.[data.current] : data.current;
    settings = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    // Static `{% section 'x' %}` instances keep their saved settings under current.sections.
    if (settings.sections && typeof settings.sections === 'object') staticSections = settings.sections;
  } catch { /* optional settings data */ }
  settings = applyThemeSettingDefaults(files, settings);
  const moneyCurrency = String(contextOverrides.shop?.currency ?? 'USD');
  const engine = new Liquid({ templates: textTemplates, extname: '.liquid', strictFilters: false, strictVariables: false, ownPropertyOnly: true, renderLimit: 2500, memoryLimit: 4 * 1024 * 1024 });
  const themeAssetUrl = (name: string) => {
    const assetName = String(name ?? '').replace(/^\/?assets\//i, '').replace(/^\//, '');
    const file = byPath.get(`assets/${assetName}`);
    if (!file) return '';
    if (file.encoding === 'utf8') return `data:${mimeType(file.path)};base64,${Buffer.from(file.content).toString('base64')}`;
    return `data:${mimeType(file.path)};base64,${file.content}`;
  };
  engine.registerFilter('asset_url', (name: string) => themeAssetUrl(name));
  engine.registerFilter('stylesheet_tag', (url: string) => `<link rel="stylesheet" href="${escapeAttribute(url)}">`);
  engine.registerFilter('script_tag', (url: string) => `<script src="${escapeAttribute(url)}"></script>`);
  engine.registerFilter('money', (value: unknown) => formatMoney(value, moneyCurrency));
  engine.registerFilter('money_with_currency', (value: unknown) => `${formatMoney(value, moneyCurrency)} ${moneyCurrency}`);
  engine.registerFilter('money_without_currency', (value: unknown) => formatMoneyAmount(value));
  engine.registerFilter('money_without_trailing_zeros', (value: unknown) => formatMoney(value, moneyCurrency, true));
  engine.registerFilter('image_url', (value: any) => resolveThemeImageUrl(value, themeAssetUrl));
  engine.registerFilter('image_tag', (url: string, alt = '') => `<img src="${escapeAttribute(resolveThemeImageUrl(url, themeAssetUrl))}" alt="${escapeAttribute(alt)}">`);
  engine.registerFilter('img_url', (value: any) => resolveThemeImageUrl(value, themeAssetUrl));
  engine.registerFilter('img_tag', (url: string, alt = '') => `<img src="${escapeAttribute(resolveThemeImageUrl(url, themeAssetUrl))}" alt="${escapeAttribute(alt)}">`);
  engine.registerFilter('video_tag', (value: any) => {
    const src = typeof value === 'string' && value.startsWith('assets/') ? themeAssetUrl(value) : String(value?.sources?.[0]?.url ?? value?.url ?? value ?? '');
    return src ? `<video controls><source src="${escapeAttribute(src)}"></video>` : '';
  });
  registerShopifyFilters(engine, files);
  engine.registerFilter('handleize', (value: unknown) => String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  engine.registerFilter('handle', (value: unknown) => String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

  const context: Record<string, any> = {
    shop: { name: 'Store preview', currency: 'USD', money_format: '${{amount}}' },
    settings,
    request: { page_type: 'index', origin: '' },
    page: { title: 'Home' },
    cart: { item_count: 0, total_price: 0, items: [] },
    routes: { root_url: '/', cart_url: '/cart', search_url: '/search', account_url: '/account' },
    products: { featured: { id: 1, title: 'Featured product', price: 0, available: true, url: '/product/featured', featured_image: null, images: [], variants: [] } },
    content_for_header: '',
    ...contextOverrides,
  };
  const renderLiquid = async (source: string, scope: Record<string, any> = {}) => {
    const productId = scope.product?.id ?? context.product?.id;
    const productType = scope.product?.type ?? context.product?.type;
    return engine.parseAndRender(preprocessShopifyTags(source, productId, productType), { ...context, ...scope });
  };
  const renderSection = async (key: string, section: any) => {
    const type = String(section?.type ?? '');
    if (!/^[a-z0-9_-]+$/i.test(type)) return '';
    const file = byPath.get(`sections/${type}.liquid`);
    if (!file) return '';
    section = { ...(staticSections[key] ?? {}), ...(section ?? {}), type };
    const withDefaults = applySectionSettingDefaults(file.content, section);
    section = { ...section, settings: withDefaults.settings, blocks: withDefaults.blocks };
    const resolvedBlocks = Object.fromEntries(Object.entries(section.blocks ?? {}).map(([blockId, block]: [string, any]) => [
      blockId, { ...block, settings: resolveLiquidResourceSettings(block.settings ?? {}, context.__resources) },
    ]));
    const sectionContext = { id: key, type, settings: resolveLiquidResourceSettings(section.settings ?? {}, context.__resources), blocks: resolvedBlocks, block_order: section.block_order ?? [] };
    const blockMarkup = await renderSectionBlocks(section, sectionContext, byPath, renderLiquid, context.__resources);
    const blockPlaceholder = `<!-- SOLVEXO_SECTION_BLOCKS_${escapeAttribute(key)} -->`;
    const source = file.content.replace(/\{%[-+]?\s*content_for\s+['"]blocks['"][^%]*[-+]?%\}/g, blockPlaceholder);
    const markup = (await renderLiquid(source, { section: sectionContext })).replace(blockPlaceholder, blockMarkup);
    return `<div data-shopify-section="${escapeAttribute(key)}">${markup}</div>`;
  };
  const renderJsonTemplate = async (path: string) => {
    const file = byPath.get(path);
    if (!file) return null;
    const definition = safeJson(file.content);
    if (!definition) return null;
    const parts: string[] = [];
    for (const key of definition.order ?? []) {
      const section = definition.sections?.[key];
      if (section?.disabled === true) continue;
      parts.push(await renderSection(key, section));
    }
    return parts.join('\n');
  };

  const template = selectTemplatePath(byPath, requestedPath, context.product, context.collection);
  let content = await renderJsonTemplate(template.json);
  if (content === null && byPath.has(template.liquid)) content = await renderLiquid(byPath.get(template.liquid)!.content);
  if (content === null) content = '<main><h1>Theme preview</h1><p>This theme has no home page template.</p></main>';
  const layoutFile = byPath.get('layout/theme.liquid');
  if (layoutFile) {
    let layout = preprocessShopifyTags(layoutFile.content).replace(/\{\%[-+]?\s*content_for_header\s*[-+]?\%\}/g, '');
    layout = layout.replace(/\{\{[-+]?\s*content_for_layout\s*[-+]?\}\}/g, '<!-- SHOPIFY_CONTENT_FOR_LAYOUT -->');
    layout = await replaceAsync(layout, /\{%[-+]?\s*section\s+['"]([^'"]+)['"]\s*[-+]?%\}/g, async (_match, sectionName) => renderSection(sectionName, { type: sectionName }));
    layout = await replaceAsync(layout, /\{%[-+]?\s*sections\s+['"]([^'"]+)['"]\s*[-+]?%\}/g, async (_match, groupName) => {
      const group = byPath.get(`sections/${groupName}.json`);
      if (!group) return '';
      const definition = safeJson(group.content);
      if (!definition) return '';
      const blocks: string[] = [];
      for (const key of definition.order ?? []) {
        const section = definition.sections?.[key];
        if (section?.disabled === true) continue;
        blocks.push(await renderSection(key, section));
      }
      return blocks.join('\n');
    });
    let rendered = await renderLiquid(layout);
    rendered = rendered.replace('<!-- SHOPIFY_CONTENT_FOR_LAYOUT -->', content);
    if (!/<html[\s>]/i.test(rendered)) rendered = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${rendered}</body></html>`;
    rendered = applyPreviewCsp(appendStorefrontBridge(rendered, String(context.__storefrontOrigin ?? '')));
    return rendered;
  }
  return applyPreviewCsp(appendStorefrontBridge(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Theme preview</title></head><body>${content}</body></html>`, String(context.__storefrontOrigin ?? '')));
}

function stripSchemaTags(source: string): string { return source.replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/g, ''); }
export function findPaginatePageSize(files: PackageFile[], expression: string): number | null {
  const escapedExpression = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\{%[-+]?\\s*paginate\\s+${escapedExpression}\\s+by\\s+(\\d+)\\b[^%]*[-+]?%\\}`, 'i');
  for (const file of files) {
    if (file.encoding !== 'utf8' || !/\.(?:liquid|json)$/i.test(file.path)) continue;
    const match = pattern.exec(file.content);
    if (match) return Math.max(1, Math.min(Number(match[1]), 250));
  }
  return null;
}
function getRequestedPage(path: string): number {
  const value = new URLSearchParams(path.split('?')[1] ?? '').get('page');
  if (value === null || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new BadRequestException('Requested page is out of range');
  return page;
}
function buildCollectionProductFilter(rules: any): Record<string, any> {
  const clauses: Record<string, any>[] = [];
  if (rules?.categoryId) clauses.push({ $or: [{ categoryId: rules.categoryId }, { subCategoryId: rules.categoryId }] });
  if (rules?.tags?.length) clauses.push({ tags: { $in: rules.tags } });
  if (!clauses.length) return {};
  return rules?.matchType === 'all' ? { $and: clauses } : { $or: clauses };
}
export function buildShopifyPagination(totalItems: number, pageSize: number, currentPage: number, path: string) {
  const pages = Math.ceil(totalItems / pageSize);
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  const pageUrl = (page: number) => {
    const params = new URLSearchParams(query);
    params.set('page', String(page));
    return `${path.split('?')[0]}?${params.toString()}`;
  };
  const visiblePages = new Set<number>([1, pages]);
  for (let page = Math.max(1, currentPage - 2); page <= Math.min(pages, currentPage + 2); page++) visiblePages.add(page);
  const sortedPages = [...visiblePages].filter((page) => page > 0).sort((a, b) => a - b);
  const parts: Record<string, any>[] = [];
  let previousPage = 0;
  for (const page of sortedPages) {
    if (previousPage && page - previousPage > 1) parts.push({ type: 'ellipsis', title: '…', is_link: false, is_current: false, url: null });
    parts.push({ type: 'page', title: String(page), is_link: page !== currentPage, is_current: page === currentPage, url: pageUrl(page) });
    previousPage = page;
  }
  const hasPrevious = currentPage > 1 && pages > 0;
  const hasNext = currentPage < pages;
  return {
    page_size: pageSize,
    current_page: currentPage,
    current_offset: Math.min((currentPage - 1) * pageSize, totalItems),
    items: Math.max(0, Math.min(pageSize, totalItems - (currentPage - 1) * pageSize)),
    pages,
    parts,
    previous: hasPrevious ? { title: 'Previous', url: pageUrl(currentPage - 1) } : null,
    next: hasNext ? { title: 'Next', url: pageUrl(currentPage + 1) } : null,
  };
}
function preprocessShopifyTags(source: string, productId?: string, productType?: string): string {
  return stripSchemaTags(source)
    .replace(/\{%[-+]?\s*style\s*[-+]?%\}/g, '<style>')
    .replace(/\{%[-+]?\s*endstyle\s*[-+]?%\}/g, '</style>')
    .replace(/\{%[-+]?\s*javascript\s*[-+]?%\}/g, '<script>')
    .replace(/\{%[-+]?\s*endjavascript\s*[-+]?%\}/g, '</script>')
    .replace(/\{%[-+]?\s*content_for\s+['"]blocks['"][^%]*[-+]?%\}/g, '')
    .replace(/(\{%[-+]?\s*(?:render|include)\s+)(['"])([^'"]+)\2/g, (_match, prefix, quote, name) => {
      const fileName = String(name).replace(/\.liquid$/i, '');
      const withDirectory = fileName.includes('/') ? fileName : `snippets/${fileName}`;
      return `${prefix}${quote}${withDirectory}${quote}`;
    })
    .replace(/\{%[-+]?\s*form\s+['"]([^'"]+)['"]([^%]*?)[-+]?%\}/g, (_match, formType: string, rest: string) => {
      const action = formType === 'product' ? '/cart/add' : formType === 'cart' ? '/cart'
        : formType === 'customer_login' ? '/login' : formType === 'create_customer' ? '/register'
          : formType === 'recover_customer_password' ? '/forgot-password' : formType === 'customer' ? '/newsletter'
            : formType === 'contact' ? '/contact' : '/search';
      let productAttrs = '';
      if (formType === 'product') {
        // `{% form 'product', card_product %}` — the product expression is the form's second argument.
        const expr = /^\s*,\s*([A-Za-z_][\w.\[\]'"-]*)/.exec(rest)?.[1];
        productAttrs = expr
          ? ` data-product-id="{{ ${expr}.id }}" data-product-type="{{ ${expr}.type | default: 'physical' }}"`
          : productId ? ` data-product-id="${escapeAttribute(productId)}" data-product-type="${productType === 'digital' ? 'digital' : 'physical'}"` : '';
      }
      return `<form method="post" action="${action}" data-shopify-form="${formType}"${productAttrs}>`;
    })
    .replace(/\{%[-+]?\s*endform\s*[-+]?%\}/g, '</form>')
    .replace(/\{%[-+]?\s*paginate\b[^%]*[-+]?%\}/g, '')
    .replace(/\{%[-+]?\s*endpaginate\s*[-+]?%\}/g, '');
}
async function renderSectionBlocks(
  section: any,
  sectionContext: Record<string, any>,
  files: Map<string, { content: string }>,
  renderLiquid: (source: string, scope?: Record<string, any>) => Promise<string>,
  resources: Record<string, any> = {},
): Promise<string> {
  const definitions = section?.blocks ?? {};
  const order: string[] = Array.isArray(section?.block_order) ? section.block_order : Object.keys(definitions);
  const rendered = await Promise.all(order.map(async (id) => {
    const definition = definitions[id];
    if (definition?.disabled === true) return '';
    const type = String(definition?.type ?? '');
    if (!/^[a-z0-9_-]+$/i.test(type)) return '';
    const file = files.get(`blocks/${type}.liquid`);
    if (!file) return '';
    const block = {
      id,
      type,
      settings: resolveLiquidResourceSettings(definition.settings ?? {}, resources),
      shopify_attributes: `data-shopify-editor-block="${escapeAttribute(id)}"`,
    };
    return renderLiquid(file.content, { section: sectionContext, block });
  }));
  return rendered.join('\n');
}
function collectLiquidResourceIds(files: PackageFile[]): string[] {
  const ids = new Set<string>();
  const addValues = (value: unknown) => {
    if (ids.size >= 500 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(addValues);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'settings' || key === 'current') addValues(nested);
      else if (key === 'blocks' || key === 'sections' || key === 'presets') addValues(nested);
      else if (typeof nested === 'string' && /^[a-f\d]{24}$/i.test(nested)) ids.add(nested);
      else if (nested && typeof nested === 'object') addValues(nested);
    }
  };
  for (const file of files) {
    if (file.encoding !== 'utf8' || !file.path.endsWith('.json')) continue;
    try {
      addValues(JSON.parse(file.content));
    } catch {
      continue;
    }
  }
  return [...ids];
}
function resolveLiquidResourceSettings(settings: Record<string, any>, resources: Record<string, any> = {}) {
  const resolve = (value: any): any => {
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value === 'string' && Object.hasOwn(resources, value)) return resources[value];
    return value;
  };
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, resolve(value)]));
}
function toLiquidMenuLink(item: any, resources: Record<string, any>) {
  const collection = item.collectionId ? resources[String(item.collectionId)] : undefined;
  const product = item.productId ? resources[String(item.productId)] : undefined;
  const href = item.linkType === 'external' ? item.url
    : item.linkType === 'page' ? `/pages/${encodeURIComponent(item.pageSlug ?? '')}`
      : item.linkType === 'blog' ? `/blogs/${encodeURIComponent(item.pageSlug ?? '')}`
        : item.linkType === 'collection' ? collection?.url ?? `/collections/${encodeURIComponent(item.collectionId ?? '')}`
          : item.linkType === 'category' ? `/collections/${encodeURIComponent(item.categoryId ?? '')}`
            : item.linkType === 'product' ? product?.url ?? `/products/${encodeURIComponent(item.productId ?? '')}`
            : item.linkType === 'search' ? '/search' : '/';
  return {
    title: item.label ?? '',
    url: href || '/',
    object: null,
    active: false,
    current: false,
    child_active: false,
    levels: item.children?.length ? 1 : 0,
    links: (item.children ?? []).map((child: any) => toLiquidMenuLink(child, resources)),
  };
}
function appendStorefrontBridge(html: string, origin: string): string {
  const safeOrigin = escapeAttribute(origin);
  const base = `<base href="${safeOrigin}/">`;
  const bridge = `<script>(function(){function send(data){parent.postMessage(data,'*');}function size(){send({type:'solvexo:resize',height:Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)});}document.addEventListener('click',function(e){var a=e.target.closest('a[href]');if(!a)return;var u;try{u=new URL(a.getAttribute('href'),${JSON.stringify(origin)});}catch(_){return;}if(u.origin!==${JSON.stringify(origin)})return;if(u.pathname==='/cart/clear'){e.preventDefault();send({type:'solvexo:cart-clear'});return;}if(u.pathname==='/cart/change'){e.preventDefault();var variantId=u.searchParams.get('id');var line=Number(u.searchParams.get('line'));var quantity=Number(u.searchParams.get('quantity')||0);if(Number.isInteger(quantity)&&quantity>=0&&quantity<=999)send({type:'solvexo:cart-update',items:[variantId?{variantId:variantId,quantity:quantity}:{index:line-1,quantity:quantity}]});return;}e.preventDefault();send({type:'solvexo:navigate',path:u.pathname+u.search+u.hash});});document.addEventListener('submit',function(e){var f=e.target;if(!(f instanceof HTMLFormElement))return;var kind=f.dataset.shopifyForm;if(kind==='product'){e.preventDefault();var d=new FormData(f);send({type:'solvexo:add-to-cart',productId:f.dataset.productId,productType:f.dataset.productType,variantId:String(d.get('id')||''),quantity:Number(d.get('quantity')||1)});}else if(kind==='search'){e.preventDefault();var d=new FormData(f);send({type:'solvexo:navigate',path:'/search?q='+encodeURIComponent(String(d.get('q')||''))});}else if(kind==='cart'){e.preventDefault();if(f.action.indexOf('/cart/clear')!==-1){send({type:'solvexo:cart-clear'});return;}if(e.submitter&&e.submitter.name==='checkout'){send({type:'solvexo:checkout'});return;}var items=[];var index=0;new FormData(f).forEach(function(value,key){var match=/^updates\\[([^\\]]*)\\]$/.exec(key);if(!match)return;var quantity=Number(value);if(Number.isInteger(quantity)&&quantity>=0&&quantity<=999)items.push(match[1]?{variantId:match[1],quantity:quantity}:{index:index,quantity:quantity});index++;});send({type:'solvexo:cart-update',items:items});}else if(kind==='customer'){e.preventDefault();var d=new FormData(f);send({type:'solvexo:subscribe',email:String(d.get('contact[email]')||d.get('email')||'')});window.__solvexoForm=f;}else if(kind==='contact'){e.preventDefault();note(f,'Contact messages are not available on this store yet.',false);}else if(kind){e.preventDefault();send({type:'solvexo:navigate',path:f.getAttribute('action')||'/'});}},true);function note(f,text,ok){var n=f.querySelector('[data-solvexo-note]');if(!n){n=document.createElement('p');n.setAttribute('data-solvexo-note','');n.setAttribute('role',ok?'status':'alert');f.appendChild(n);}n.textContent=text;}window.addEventListener('message',function(ev){var m=ev.data;if(ev.source!==parent||!m||m.type!=='solvexo:subscribed'||!window.__solvexoForm)return;note(window.__solvexoForm,String(m.message||''),!!m.ok);});new MutationObserver(size).observe(document.documentElement,{childList:true,subtree:true,attributes:true});window.addEventListener('load',size);window.addEventListener('resize',size);size();})();</script>`;
  let output = html;
  if (/<head(?:\s[^>]*)?>/i.test(output)) output = output.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${base}`);
  else output = `${base}${output}`;
  if (/<\/body>/i.test(output)) return output.replace(/<\/body>/i, `${bridge}</body>`);
  return `${output}${bridge}`;
}
async function replaceAsync(source: string, pattern: RegExp, replacer: (...args: any[]) => Promise<string>): Promise<string> {
  const matches = [...source.matchAll(pattern)];
  const rendered = await Promise.all(matches.map((match) => replacer(...match)));
  let result = source;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    result = `${result.slice(0, match.index)}${rendered[i]}${result.slice(match.index! + match[0].length)}`;
  }
  return result;
}
function mimeType(path: string): string {
  const ext = extension(path);
  return ({ '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
function normalizeStorefrontPath(input: string): string {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || /[\r\n\\]/.test(input)) {
    throw new BadRequestException('Storefront path must be a local absolute path');
  }
  const withoutHash = input.split('#', 1)[0];
  const queryIndex = withoutHash.indexOf('?');
  const pathname = (queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex)) || '/';
  if (pathname.split('/').some((part) => part === '.' || part === '..')) throw new BadRequestException('Storefront path is invalid');
  if (withoutHash.length > 2048) throw new BadRequestException('Storefront path is too long');
  return pathname + (queryIndex < 0 ? '' : withoutHash.slice(queryIndex));
}
function getPageType(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname === '/') return 'index';
  if (pathname.startsWith('/products/') || pathname.startsWith('/product/')) return 'product';
  if (pathname.startsWith('/collections/')) return 'collection';
  if (pathname === '/blog') return 'blog';
  if (pathname.startsWith('/blog/')) return 'article';
  if (pathname.startsWith('/blogs/')) return routeSegment(pathname, 3) ? 'article' : 'blog';
  if (pathname.startsWith('/pages/')) return 'page';
  if (pathname === '/search') return 'search';
  if (pathname === '/cart') return 'cart';
  if (/^\/[^/]+$/.test(pathname) && ![
    '/checkout', '/login', '/register', '/account', '/wishlist', '/messages',
    '/notifications', '/returns', '/gift-cards', '/store-credit', '/orders',
    '/addresses', '/reviews', '/faqs', '/search', '/cart', '/blog',
  ].includes(pathname)) return 'page';
  return '404';
}
function selectTemplatePath(byPath: Map<string, PackageFile>, path: string, product?: { templateKey?: string } | null, collection?: { templateKey?: string } | null) {
  const pageType = getPageType(path);
  // Shopify "alternate templates" (product.alt.json / collection.alt.json) assigned per resource.
  const templateKey = pageType === 'product' ? product?.templateKey ?? 'default' : pageType === 'collection' ? collection?.templateKey ?? 'default' : 'default';
  const json = `templates/${pageType}.${templateKey}.json`;
  if (byPath.has(json)) return { json, liquid: `templates/${pageType}.${templateKey}.liquid` };
  const fallbackJson = `templates/${pageType}.json`;
  if (byPath.has(fallbackJson)) return { json: fallbackJson, liquid: `templates/${pageType}.liquid` };
  return { json: 'templates/index.json', liquid: 'templates/index.liquid' };
}
/** A theme file saved through Edit code can hold malformed JSON — never let that 500 a live page. */
function safeJson(text: string): any | null {
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
function routeSegment(path: string, index: number): string | undefined {
  const segment = path.split(/[?#]/, 1)[0].split('/')[index];
  if (!segment) return undefined;
  try { return decodeURIComponent(segment); }
  catch { throw new BadRequestException('Storefront path contains invalid URL encoding'); }
}
function availableQuantity(variant: any): number {
  return Math.max(0, Number(variant.stock ?? 0) - Number(variant.committedStock ?? 0)
    - Number(variant.damagedStock ?? 0) - Number(variant.inTransitStock ?? 0));
}
function productMatchesCollection(product: any, rules: any): boolean {
  const clauses: boolean[] = [];
  if (rules?.categoryId) clauses.push(product.categoryId === rules.categoryId || product.subCategoryId === rules.categoryId);
  if (rules?.tags?.length) clauses.push((product.tags ?? []).some((tag: string) => rules.tags.includes(tag)));
  if (!clauses.length) return true;
  return rules?.matchType === 'all' ? clauses.every(Boolean) : clauses.some(Boolean);
}
function renderBlogContent(blocks: any[]): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((block) => block?.enabled !== false).map((block) => {
    const settings = block.settings ?? {};
    const text = escapeAttribute(settings.text ?? settings.content ?? '');
    if (block.type === 'heading') return `<h2>${text}</h2>`;
    if (block.type === 'image' && settings.url) return `<img src="${escapeAttribute(settings.url)}" alt="${escapeAttribute(settings.alt ?? '')}">`;
    if (block.type === 'quote') return `<blockquote>${text}</blockquote>`;
    if (block.type === 'divider') return '<hr>';
    if (block.type === 'list') {
      const items = String(settings.text ?? '').split(/\r?\n/).filter(Boolean)
        .map((item) => `<li>${escapeAttribute(item)}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${text}</p>`;
  }).join('\n');
}
function renderPageContent(sections: any[]): string {
  if (!Array.isArray(sections)) return '';
  return sections.filter((section) => section?.enabled !== false).map((section) => {
    const settings = section.settings ?? {};
    const headingText = settings.heading ?? settings.title ?? '';
    const heading = headingText ? `<h2>${escapeAttribute(headingText)}</h2>` : '';
    const text = settings.text ?? settings.content ?? settings.body ?? '';
    const body = text ? `<p>${escapeAttribute(text)}</p>` : '';
    const blocks = renderBlogContent(section.blocks ?? []);
    return heading || body || blocks ? `<section>${heading}${body}${blocks}</section>` : '';
  }).join('\n');
}
function escapeAttribute(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c); }
function formatMoney(value: unknown, currency: string, trimZeros = false): string {
  const numeric = Number(value ?? 0);
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: safeCurrency, maximumFractionDigits: 2, minimumFractionDigits: trimZeros ? 0 : 2 }).format(numeric / 100)
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: safeCurrency, maximumFractionDigits: 2, minimumFractionDigits: trimZeros ? 0 : 2 }).format(0);
}
function formatMoneyAmount(value: unknown): string {
  const numeric = Number(value ?? 0) / 100;
  if (!Number.isFinite(numeric)) return '0.00';
  return numeric.toFixed(2);
}
function resolveThemeImageUrl(value: any, themeAssetUrl: (name: string) => string): string {
  const source = typeof value === 'string' ? value : value?.src ?? value?.url ?? '';
  if (typeof source !== 'string') return '';
  if (/^\/?assets\//i.test(source)) return themeAssetUrl(source) || source;
  return source;
}
function applyPreviewCsp(html: string): string {
  const policy = "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' data:; font-src data:; script-src 'unsafe-inline' data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri https:";
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  return /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${tag}`) : html;
}
