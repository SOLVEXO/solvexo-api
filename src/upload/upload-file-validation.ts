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
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif',
  'mp4', 'webm', 'mov', 'mpeg', 'ogg', 'ogv',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip',
]);

// Private `/api/upload/private-file` — digital products + KYC documents,
// matching `UploadService.getMimeTypeFromExtension`'s existing extension map
// (the app's own authoritative list of what this route already handles).
const ALLOWED_PRIVATE_EXTENSIONS = new Set([
  'pdf', 'epub', 'zip', 'mp3', 'mp4',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
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
