/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

// Real allow-list validation for `FileInterceptor` uploads — previously
// `upload.controller.ts` had a file-size limit only, no MIME/extension
// check at all, so any file type could be uploaded to either route.
// Checks BOTH mimetype and extension (accepting if either matches) since
// browsers/OSes are inconsistent about the mimetype they report for the
// same file (e.g. a `.zip`/`.csv` sometimes arrives as
// `application/octet-stream`) — rejecting on a mismatched-but-still-known
// extension would break real, already-working uploads.

// Public `/api/upload/file` — images/video (every `ImageUpload` call site)
// plus the document/archive types the Files Library (`FilesLibrary.tsx`)
// already uploads through this same route.
const ALLOWED_PUBLIC_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif',
  'mp4', 'webm', 'mov', 'mpeg', 'ogg', 'ogv',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip',
]);

// Private `/api/upload/private-file` — digital products + KYC documents,
// matching `UploadService.getMimeTypeFromExtension`'s existing extension map
// (the app's own authoritative list of what this route already handles).
const ALLOWED_PRIVATE_EXTENSIONS = new Set([
  'pdf', 'epub', 'zip', 'mp3', 'mp4',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv',
]);

function getExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

function isAllowedMimetypePrefix(mimetype: string): boolean {
  return mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/');
}

export function createUploadFileFilter(allowedExtensions: Set<string>) {
  return (_req: any, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) => {
    const ext = getExtension(file.originalname || '');
    // SVG can carry <script>; never accepted (no frontend caller uploads it).
    if (ext === 'svg' || /svg/i.test(file.mimetype || '')) {
      callback(new BadRequestException('SVG uploads are not allowed'), false);
      return;
    }
    const allowed = isAllowedMimetypePrefix(file.mimetype) || allowedExtensions.has(ext);
    if (!allowed) {
      callback(new BadRequestException(`File type not allowed: ${ext || file.mimetype}`), false);
      return;
    }
    callback(null, true);
  };
}

export const publicUploadFileFilter = createUploadFileFilter(ALLOWED_PUBLIC_EXTENSIONS);
export const privateUploadFileFilter = createUploadFileFilter(ALLOWED_PRIVATE_EXTENSIONS);

// ── Magic-byte verification ─────────────────────────────────────────────
// The client-reported mimetype/extension are untrusted; after multer buffers
// the file we check the real leading bytes against the claimed extension.

export type DetectedKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'pdf' | 'zip' | 'ole' | 'mp4' | 'webm' | 'ogg' | 'mpeg' | 'mp3' | null;

const startsWith = (b: Buffer, sig: number[], offset = 0) => b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

export function detectFileKind(b: Buffer): DetectedKind {
  if (!b || b.length < 4) return null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (ascii(b, 0, 4) === 'OggS') return 'ogg';
  if (startsWith(b, [0x00, 0x00, 0x01, 0xba]) || startsWith(b, [0x00, 0x00, 0x01, 0xb3])) return 'mpeg';
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    return brand === 'avif' || brand === 'avis' ? 'avif' : 'mp4'; // mp4 / mov / m4a share the ISO-BMFF box layout
  }
  return null;
}

const KINDS_BY_EXTENSION: Record<string, DetectedKind[]> = {
  png: ['png'], jpg: ['jpeg'], jpeg: ['jpeg'], gif: ['gif'], webp: ['webp'], avif: ['avif'],
  mp4: ['mp4'], mov: ['mp4'], webm: ['webm'], ogg: ['ogg'], ogv: ['ogg'], mpeg: ['mpeg', 'mp4'], mp3: ['mp3'],
  pdf: ['pdf'], zip: ['zip'], epub: ['zip'],
  docx: ['zip'], xlsx: ['zip'], pptx: ['zip'],
  doc: ['ole'], xls: ['ole'], ppt: ['ole'],
};
const TEXT_EXTENSIONS = new Set(['txt', 'csv']);

/** Plain text/CSV has no signature: accept only if there are no NUL bytes and it is not markup. */
function looksLikePlainText(b: Buffer): boolean {
  const head = b.subarray(0, 8192);
  if (head.includes(0)) return false;
  return !/^\s*(<\?xml|<svg|<!doctype|<html|<script)/i.test(head.toString('utf8'));
}

/** Per-category size ceilings (multer's own limit is the outer cap for video/archives). */
export function maxBytesForExtension(ext: string): number {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) return 10 * 1024 * 1024;
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'].includes(ext)) return 50 * 1024 * 1024;
  return Number.POSITIVE_INFINITY;
}

/** Throws BadRequestException when the buffer's real type does not match the claimed extension. */
export function assertFileSignature(file: { originalname?: string; mimetype?: string; buffer?: Buffer; size?: number }): void {
  const ext = getExtension(file.originalname || '');
  const buf = file.buffer;
  if (!buf || !buf.length) throw new BadRequestException('Empty file');
  if (TEXT_EXTENSIONS.has(ext)) {
    if (!looksLikePlainText(buf)) throw new BadRequestException('File content does not match its type');
  } else {
    const kind = detectFileKind(buf);
    const expected = KINDS_BY_EXTENSION[ext];
    // Unknown extension (accepted only via an image/video/audio mimetype): any real media signature will do.
    const ok = expected ? expected.includes(kind) : kind !== null && kind !== 'zip' && kind !== 'ole' && kind !== 'pdf';
    if (!ok) throw new BadRequestException('File content does not match its type');
  }
  if (buf.length > maxBytesForExtension(ext)) throw new BadRequestException('File is too large for its type');
}
