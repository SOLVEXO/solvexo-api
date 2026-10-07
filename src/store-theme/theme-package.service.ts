/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as yauzl from 'yauzl';
import { Liquid } from 'liquidjs';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
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
    if (!archive?.length || archive.length > MAX_ARCHIVE_BYTES) throw new BadRequestException('Theme ZIP must be between 1 byte and 8 MiB.');
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

  async rollback(storeId: string, sellerId: string, installedThemeId: string, version: number) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const target = await this.packages.findOne({ storeId, installedThemeId, version }).lean();
    if (!target) throw new NotFoundException('Theme source revision not found');
    return this.createRevision(storeId, installedThemeId, sellerId, target.files as any, 'rollback', version);
  }

  async preview(storeId: string, sellerId: string, installedThemeId: string, version?: number) {
    await verifyStoreOwnershipStrict(this.stores, storeId, sellerId);
    await this.assertInstalledTheme(storeId, installedThemeId);
    const revision = version === undefined
      ? await this.latest(storeId, installedThemeId)
      : await this.packages.findOne({ storeId, installedThemeId, version });
    if (!revision) throw new NotFoundException('Upload a theme package before previewing it');
    const html = await renderThemePreview(revision.files as any[]);
    return { success: true, data: { version: revision.version, html } };
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
    await this.packages.deleteMany({ storeId, installedThemeId, version: { $lte: version - MAX_REVISIONS } });
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

async function renderThemePreview(files: PackageFile[]): Promise<string> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const textTemplates = Object.fromEntries(files.filter((file) => file.encoding === 'utf8').map((file) => [file.path, file.content]));
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(byPath.get('config/settings_data.json')?.content ?? '{}').current ?? {}; } catch { /* optional settings data */ }
  const engine = new Liquid({ templates: textTemplates, extname: '.liquid', strictFilters: false, strictVariables: false, ownPropertyOnly: true, renderLimit: 2500, memoryLimit: 4 * 1024 * 1024 });
  engine.registerFilter('asset_url', (name: string) => {
    const file = byPath.get(`assets/${String(name).replace(/^\//, '')}`);
    if (!file) return '';
    if (file.encoding === 'utf8') return `data:${mimeType(file.path)};base64,${Buffer.from(file.content).toString('base64')}`;
    return `data:${mimeType(file.path)};base64,${file.content}`;
  });
  engine.registerFilter('stylesheet_tag', (url: string) => `<link rel="stylesheet" href="${escapeAttribute(url)}">`);
  engine.registerFilter('script_tag', (url: string) => `<script src="${escapeAttribute(url)}"></script>`);
  engine.registerFilter('money', (value: unknown) => formatMoney(value));
  engine.registerFilter('money_with_currency', (value: unknown) => `${formatMoney(value)} USD`);
  engine.registerFilter('image_url', (value: any) => typeof value === 'string' ? value : value?.src ?? value?.url ?? '');
  engine.registerFilter('image_tag', (url: string, alt = '') => `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}">`);

  const context = {
    shop: { name: 'Store preview', currency: 'USD', money_format: '${{amount}}' },
    settings,
    request: { page_type: 'index', origin: '' },
    page: { title: 'Home' },
    cart: { item_count: 0, total_price: 0, items: [] },
    routes: { root_url: '/', cart_url: '/cart', search_url: '/search', account_url: '/account' },
    products: { featured: { id: 1, title: 'Featured product', price: 0, available: true, url: '/product/featured', featured_image: null, images: [], variants: [] } },
    content_for_header: '',
  };
  const renderLiquid = async (source: string, scope: Record<string, any> = {}) => engine.parseAndRender(preprocessShopifyTags(source), { ...context, ...scope });
  const renderSection = async (key: string, section: any) => {
    const type = String(section?.type ?? '');
    if (!/^[a-z0-9_-]+$/i.test(type)) return '';
    const file = byPath.get(`sections/${type}.liquid`);
    if (!file) return '';
    const markup = await renderLiquid(file.content, { section: { id: key, type, settings: section.settings ?? {}, blocks: section.blocks ?? [], block_order: section.block_order ?? [] } });
    return `<div data-shopify-section="${escapeAttribute(key)}">${markup}</div>`;
  };
  const renderJsonTemplate = async (path: string) => {
    const file = byPath.get(path);
    if (!file) return null;
    const definition = JSON.parse(file.content);
    const parts: string[] = [];
    for (const key of definition.order ?? []) parts.push(await renderSection(key, definition.sections?.[key]));
    return parts.join('\n');
  };

  let content = await renderJsonTemplate('templates/index.json');
  if (content === null && byPath.has('templates/index.liquid')) content = await renderLiquid(byPath.get('templates/index.liquid')!.content);
  if (content === null) content = '<main><h1>Theme preview</h1><p>This theme has no home page template.</p></main>';
  const layoutFile = byPath.get('layout/theme.liquid');
  if (layoutFile) {
    let layout = preprocessShopifyTags(layoutFile.content).replace(/\{\%[-+]?\s*content_for_header\s*[-+]?\%\}/g, '');
    layout = layout.replace(/\{\{[-+]?\s*content_for_layout\s*[-+]?\}\}/g, '<!-- SHOPIFY_CONTENT_FOR_LAYOUT -->');
    layout = await replaceAsync(layout, /\{%[-+]?\s*section\s+['"]([^'"]+)['"]\s*[-+]?%\}/g, async (_match, sectionName) => renderSection(sectionName, { type: sectionName }));
    layout = await replaceAsync(layout, /\{%[-+]?\s*sections\s+['"]([^'"]+)['"]\s*[-+]?%\}/g, async (_match, groupName) => {
      const group = byPath.get(`sections/${groupName}.json`);
      if (!group) return '';
      const definition = JSON.parse(group.content);
      const blocks: string[] = [];
      for (const key of definition.order ?? []) blocks.push(await renderSection(key, definition.sections?.[key]));
      return blocks.join('\n');
    });
    let rendered = await renderLiquid(layout);
    rendered = rendered.replace('<!-- SHOPIFY_CONTENT_FOR_LAYOUT -->', content);
    if (!/<html[\s>]/i.test(rendered)) rendered = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${rendered}</body></html>`;
    rendered = applyPreviewCsp(rendered);
    return rendered;
  }
  return applyPreviewCsp(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Theme preview</title></head><body>${content}</body></html>`);
}

function stripSchemaTags(source: string): string { return source.replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/g, ''); }
function preprocessShopifyTags(source: string): string {
  return stripSchemaTags(source)
    .replace(/\{%[-+]?\s*(?:style|endstyle|javascript|endjavascript)\s*[-+]?%\}/g, '')
    .replace(/\{%[-+]?\s*content_for\s+['"]blocks['"][^%]*[-+]?%\}/g, '')
    .replace(/\{%[-+]?\s*form\s+['"]([^'"]+)['"][^%]*[-+]?%\}/g, (_match, formType) => `<form method="post" action="${formType === 'product' ? '/cart/add' : formType === 'customer' ? '/account' : formType === 'contact' ? '/contact' : '/search'}" data-shopify-form="${formType}">`)
    .replace(/\{%[-+]?\s*endform\s*[-+]?%\}/g, '</form>')
    .replace(/\{%[-+]?\s*paginate\s+(.+?)\s+by\s+([\w.]+|\d+)[^%]*[-+]?%\}/g, (_match, collection, limit) => `{% for product in ${collection} limit: ${limit} %}`)
    .replace(/\{%[-+]?\s*endpaginate\s*[-+]?%\}/g, '{% endfor %}');
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
function escapeAttribute(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c); }
function formatMoney(value: unknown): string { const numeric = Number(value ?? 0); return Number.isFinite(numeric) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(numeric / 100) : '$0.00'; }
function applyPreviewCsp(html: string): string {
  const policy = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:; script-src 'unsafe-inline' data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  return /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${tag}`) : html;
}
