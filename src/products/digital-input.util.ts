import { BadRequestException } from '@nestjs/common';
const DOWNLOAD_LIMITS = ['unlimited', '1', '3', '5'];

export const MAX_DIGITAL_FILES = 50;
export const MAX_DIGITAL_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_LINK_EXPIRY_DAYS = 3650;

const ALLOWED_EXT = new Set([
  'pdf', 'zip', 'epub',
  'mp3', 'wav', 'mp4', 'mov',
  'ttf', 'otf', 'woff', 'woff2',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'psd', 'ai', 'fig',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv',
]);
const BLOCKED_EXT = new Set(['exe', 'bat', 'sh', 'msi', 'apk', 'cmd', 'com', 'scr', 'jar', 'ps1', 'vbs', 'dmg']);

const PRIVATE_ID = /^private\/digital-products\/[A-Za-z0-9_\-./ ()]+$/;

const clean = (v: any, max: number): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export const fileExt = (name: string): string => {
  const i = String(name || '').lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

/** Throws when the file name has a blocked or unlisted extension. */
export function assertAllowedDigitalFile(name: string, size: number | null): void {
  const ext = fileExt(name);
  if (BLOCKED_EXT.has(ext)) throw new BadRequestException(`File type ".${ext}" is not allowed`);
  if (!ALLOWED_EXT.has(ext)) throw new BadRequestException(`File type ".${ext || 'unknown'}" is not supported`);
  if (size !== null && size > MAX_DIGITAL_FILE_BYTES) throw new BadRequestException(`"${name}" is larger than 2 GB`);
}

function normalizeLicenseKeys(input: any, existing?: any) {
  const src = input === undefined ? existing : input;
  const enabled = !!src?.enabled;
  const n = Number(src?.activationLimit ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new BadRequestException('activationLimit must be a whole number between 1 and 1000');
  return { enabled, activationLimit: n };
}

/**
 * Allow-lists the seller-supplied `digital` payload. Server-managed fields
 * (preview.previewSource*) are never read from input.
 *
 * File array indexes are referenced by orders, so they are never reordered:
 * existing files (matched by url) keep their index, files missing from the
 * input are archived (hidden, index kept), new files are appended, and the
 * seller's order is stored in `position`.
 */
export function normalizeDigital(input: any, existing?: any): any {
  if (!input || typeof input !== 'object') throw new BadRequestException('digital must be an object');

  const limit = input.downloadLimit === undefined ? existing?.downloadLimit ?? 'unlimited' : String(input.downloadLimit);
  if (!DOWNLOAD_LIMITS.includes(limit)) {
    throw new BadRequestException(`downloadLimit must be one of: ${DOWNLOAD_LIMITS.join(', ')}`);
  }

  let linkExpiryDays: number | null = existing?.linkExpiryDays ?? null;
  if (input.linkExpiryDays !== undefined) {
    if (input.linkExpiryDays === null) linkExpiryDays = null;
    else {
      const n = Number(input.linkExpiryDays);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LINK_EXPIRY_DAYS) {
        throw new BadRequestException(`linkExpiryDays must be a whole number between 1 and ${MAX_LINK_EXPIRY_DAYS}`);
      }
      linkExpiryDays = n;
    }
  }

  const rawFiles = input.files === undefined ? null : input.files;
  if (rawFiles !== null && !Array.isArray(rawFiles)) throw new BadRequestException('files must be an array');
  if (rawFiles && rawFiles.length > MAX_DIGITAL_FILES) throw new BadRequestException(`At most ${MAX_DIGITAL_FILES} files`);

  const old: any[] = Array.isArray(existing?.files) ? existing.files.map((f: any) => (f?.toObject ? f.toObject() : f)) : [];
  let files: any[];
  if (rawFiles === null) {
    files = old;
  } else {
    files = old.map((f) => ({ ...f, archived: true }));
    rawFiles.forEach((raw: any, pos: number) => {
      if (!raw || typeof raw !== 'object') throw new BadRequestException('Invalid file entry');
      const url = clean(raw.url, 2000);
      const name = clean(raw.name, 255);
      // The upload endpoint returns a Cloudinary publicId under private/digital-products/. Only those (or a value this
      // product already holds, for legacy data) are accepted: never an arbitrary link, never another folder (e.g. KYC documents).
      const known = old.some((f) => f.url === url);
      if (!url || (!known && (!PRIVATE_ID.test(url) || url.includes('..')))) throw new BadRequestException('Each file must be uploaded through the file uploader');
      if (!name) throw new BadRequestException('Each file needs a name');
      const size = raw.size === undefined || raw.size === null ? null : Number(raw.size);
      if (size !== null && (!Number.isFinite(size) || size < 0)) throw new BadRequestException('Invalid file size');
      assertAllowedDigitalFile(name, size);

      const prev = files.findIndex((f) => f.url === url);
      // url, name, size, mimeType stay what was uploaded; only descriptive fields are editable
      const entry = {
        url,
        name,
        size,
        mimeType: clean(raw.mimeType, 100),
        label: clean(raw.label, 100),
        version: clean(raw.version, 30),
        stampPdf: !!raw.stampPdf,
        requiresPlan: clean(raw.requiresPlan, 40),
        position: pos,
        archived: false,
      };
      if (prev >= 0) files[prev] = { ...files[prev], ...entry };
      else files.push(entry);
    });
    if (!files.some((f) => !f.archived)) throw new BadRequestException('At least one file is required');
  }

  // Preview: only the flag + source index come from the client
  const prev = input.preview ?? existing?.preview ?? {};
  const idx = prev.sourceFileIndex === undefined || prev.sourceFileIndex === null ? null : Number(prev.sourceFileIndex);
  if (idx !== null && (!Number.isInteger(idx) || idx < 0 || idx >= files.length || files[idx].archived)) {
    throw new BadRequestException('preview.sourceFileIndex does not match any file');
  }

  return {
    files,
    downloadLimit: limit,
    linkExpiryDays,
    pdfStampingEnabled: input.pdfStampingEnabled === undefined ? !!existing?.pdfStampingEnabled : !!input.pdfStampingEnabled,
    licenseType: input.licenseType ?? existing?.licenseType ?? undefined,
    buyerDeliveryMessage: input.buyerDeliveryMessage === undefined ? existing?.buyerDeliveryMessage ?? null : clean(input.buyerDeliveryMessage, 2000),
    preview: { enabled: !!prev.enabled, sourceFileIndex: idx },
    licenseKeys: normalizeLicenseKeys(input.licenseKeys, existing?.licenseKeys),
  };
}
