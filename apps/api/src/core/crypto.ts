import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

/**
 * AES-256-GCM encryption for secret settings. Ciphertext is stored as
 * `enc:v1:<iv>:<tag>:<data>` so the format is self-describing and versioned.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (!isEncrypted(payload)) return payload;
  const parts = payload.slice(PREFIX.length).split(':');
  const [ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Replaces all but the last 4 characters so secrets can be displayed safely. */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.min(value.length - 4, 24))}${value.slice(-4)}`;
}
