import { Injectable, Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/**
 * AES-256-GCM envelope encryption for secrets at rest — principally each vendor's own
 * payment-gateway credentials (Mode A), which must never be readable from a DB dump.
 *
 * Envelope format:  v1.<base64 iv>.<base64 tag>.<base64 ciphertext>
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;

  constructor() {
    const secret = process.env.ENCRYPTION_KEY ?? '';
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ENCRYPTION_KEY is required in production');
      }
      this.logger.warn('ENCRYPTION_KEY unset — using a dev-only derived key. Do NOT ship this.');
    }
    // A 64-char hex key is used verbatim; anything else is stretched with scrypt.
    if (/^[0-9a-f]{64}$/i.test(secret)) {
      this.key = Buffer.from(secret, 'hex');
    } else {
      this.key = scryptSync(secret || 'foodhub-dev-insecure-key', 'foodhub-kdf-salt', 32);
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
  }

  decrypt(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Malformed ciphertext envelope');
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed ciphertext envelope');
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(envelope: string): T {
    return JSON.parse(this.decrypt(envelope)) as T;
  }

  /** Opaque token + its storable hash. The raw half is shown to the client exactly once. */
  issueToken(bytes = 32): { token: string; hash: string } {
    const token = randomBytes(bytes).toString('base64url');
    return { token, hash: this.hashToken(token) };
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  /** Last 4 characters, everything else masked — for showing a saved key without leaking it. */
  static mask(value: string | undefined | null): string {
    if (!value) return '';
    if (value.length <= 4) return '••••';
    return '••••' + value.slice(-4);
  }
}
