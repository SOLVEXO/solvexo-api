import { BadRequestException } from '@nestjs/common';

/**
 * A review's attachments live in ONE array of URLs (`Rating.media`), so the
 * server re-checks the mix the storefront promises: up to 4 photos, one audio
 * note and one video. The kind comes from the CDN folder (`uploads/audios`,
 * `uploads/videos`) or the file extension.
 */
export const REVIEW_MEDIA_RULES = {
  images: 4,
  audio: 1,
  video: 1,
} as const;

type Kind = 'image' | 'audio' | 'video';

const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba', 'webm'];
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'ogv', 'mkv', 'avi'];

function kindOf(url: string): Kind {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  if (/\/audios?\//.test(clean) || /\/audio\/upload\//.test(clean)) return 'audio';
  if (/\/videos?\//.test(clean) || /\/video\/upload\//.test(clean)) return 'video';
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  const ext = dot >= 0 ? last.slice(dot + 1) : '';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'image';
}

export function assertReviewMedia(media: string[] | null | undefined): void {
  if (media === undefined || media === null) return;
  if (!Array.isArray(media)) throw new BadRequestException('media must be an array of URLs');
  const counts: Record<Kind, number> = { image: 0, audio: 0, video: 0 };
  for (const url of media) {
    if (typeof url !== 'string' || !url.trim()) throw new BadRequestException('media entries must be non-empty URLs');
    counts[kindOf(url)] += 1;
  }
  if (counts.image > REVIEW_MEDIA_RULES.images) throw new BadRequestException('Up to 4 photos per review');
  if (counts.audio > REVIEW_MEDIA_RULES.audio) throw new BadRequestException('Only one audio note per review');
  if (counts.video > REVIEW_MEDIA_RULES.video) throw new BadRequestException('Only one video per review');
}