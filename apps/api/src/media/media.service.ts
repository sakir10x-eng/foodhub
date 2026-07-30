import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { JOBS, QueueService } from '../infra/queue.service';
import { toImageRef } from './image.mapper';

type Sharp = typeof import('sharp');

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
/** Cap the stored original — nobody needs a 4000px menu photo. */
const MAX_EDGE = 1600;

/**
 * Upload -> resize -> WebP/AVIF -> CDN.
 *
 * Images are ~70% of page weight on food sites, so this is not an afterthought:
 * every upload becomes a full responsive ladder plus a base64 LQIP, and the browser
 * only ever downloads the width it actually needs.
 *
 * WebP is encoded inline (fast, universally supported). AVIF is 2-5x slower to encode,
 * so it is queued and the `hasAvif` flag flips when it lands.
 */
@Injectable()
export class MediaService implements OnModuleInit {
  private readonly logger = new Logger(MediaService.name);
  private sharp: Sharp | null = null;
  private readonly widths: number[];
  private readonly root: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
  ) {
    this.widths = this.config.get<number[]>('media.widths') ?? [160, 320, 640, 960, 1280];
    this.root = resolve(process.cwd(), this.config.get<string>('media.localDir') ?? 'storage/media');
  }

  onModuleInit() {
    try {
      this.sharp = require('sharp');
    } catch {
      this.logger.warn('sharp not available — uploads will store the original only, with no derivatives');
    }
    this.queue.register(JOBS.IMAGE_DERIVATIVES, (payload) => this.encodeAvif(payload.imageId, payload.key));
  }

  async upload(file: { buffer: Buffer; mimetype: string; size: number }, tenantId: string | null) {
    const maxBytes = this.config.get<number>('media.maxUploadBytes') ?? 8 * 1024 * 1024;
    if (!file?.buffer?.length) throw new BadRequestException('No file received');
    if (file.size > maxBytes) {
      throw new BadRequestException(`Image is too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
    }
    if (!ACCEPTED.has(file.mimetype)) {
      throw new BadRequestException('Upload a JPEG, PNG, WebP or AVIF image');
    }

    const key = `${tenantId ?? 'platform'}/${randomUUID()}`;
    let width = 0;
    let height = 0;
    let blurhash: string | null = null;
    let bytes = file.size;

    if (this.sharp) {
      const sharp = this.sharp;
      const meta = await sharp(file.buffer).metadata();
      // EXIF-rotate first; phone photos are otherwise sideways on the storefront.
      const source = sharp(file.buffer).rotate();

      const capped = await source
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });

      width = capped.info.width;
      height = capped.info.height;
      bytes = capped.info.size;

      await Promise.all(
        this.widths
          .filter((w) => w <= width || w === this.widths[0])
          .map(async (w) => {
            const out = await sharp(capped.data)
              .resize({ width: w, withoutEnlargement: true })
              .webp({ quality: 78, effort: 4 })
              .toBuffer();
            await this.write(`${key}-${w}.webp`, out);
          }),
      );

      // 20px LQIP inlined as a data URI — a card is never a blank rectangle.
      const lqip = await sharp(capped.data).resize({ width: 20 }).webp({ quality: 30 }).toBuffer();
      blurhash = `data:image/webp;base64,${lqip.toString('base64')}`;
    } else {
      await this.write(`${key}-original`, file.buffer);
    }

    const image = await TenantContext.runAsPlatform('image rows may be platform-owned', () =>
      this.prisma.db.image.create({
        data: { tenantId, key, width, height, blurhash, sizeBytes: bytes },
        select: { id: true, key: true, width: true, height: true, blurhash: true, hasAvif: true },
      }),
    );

    if (this.sharp) {
      await this.queue.enqueue(JOBS.IMAGE_DERIVATIVES, { imageId: image.id, key });
    }

    return toImageRef(image, this.config);
  }

  /** Queued: the slow half of the ladder. */
  private async encodeAvif(imageId: string, key: string) {
    if (!this.sharp) return;
    const sharp = this.sharp;
    try {
      const base = join(this.root, `${key}-${this.widths[this.widths.length - 1]}.webp`);
      const { existsSync } = require('node:fs');
      const sourcePath = existsSync(base)
        ? base
        : join(this.root, `${key}-${this.widths[0]}.webp`);
      if (!existsSync(sourcePath)) return;

      for (const w of this.widths) {
        const out = await sharp(sourcePath)
          .resize({ width: w, withoutEnlargement: true })
          .avif({ quality: 50, effort: 3 })
          .toBuffer();
        await this.write(`${key}-${w}.avif`, out);
      }
      await TenantContext.runAsPlatform('flag avif derivatives ready', () =>
        this.prisma.db.image.update({ where: { id: imageId }, data: { hasAvif: true } }),
      );
    } catch (err) {
      this.logger.warn(`AVIF encode failed for ${key}: ${(err as Error).message}`);
    }
  }

  private async write(relative: string, data: Buffer) {
    const driver = this.config.get<string>('media.driver');
    if (driver === 's3') {
      // Swap in an S3 client here; the rest of the pipeline is storage-agnostic.
      throw new BadRequestException('S3 media driver is not configured');
    }
    const target = join(this.root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}
