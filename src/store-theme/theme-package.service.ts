/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as yauzl from 'yauzl';
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
