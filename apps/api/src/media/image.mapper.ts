import type { ConfigService } from '@nestjs/config';
import type { ImageRef } from '@foodhub/shared';

export const IMAGE_SELECT = {
  id: true,
  key: true,
  width: true,
  height: true,
  blurhash: true,
  hasAvif: true,
} as const;

export interface ImageRow {
  id: string;
  key: string;
  width: number;
  height: number;
  blurhash: string | null;
  hasAvif?: boolean;
}

/**
 * Turns a stored image into the base URL clients build a srcset from:
 *   `${url}-640.webp`, `${url}-640.avif`, ...
 * A CDN base wins over the local path so flipping to Cloudflare/bunny is one env var.
 */
export function toImageRef(image: ImageRow | null | undefined, config: ConfigService): ImageRef | null {
  if (!image) return null;
  const cdn = config.get<string>('media.cdnBase') ?? '';
  const base = cdn || config.get<string>('media.publicBase') || '/media';
  return {
    id: image.id,
    url: `${base.replace(/\/$/, '')}/${image.key}`,
    blurhash: image.blurhash,
    width: image.width,
    height: image.height,
    hasAvif: image.hasAvif ?? false,
  };
}
