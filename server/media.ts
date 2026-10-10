import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { DomainError } from './domain.ts';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_PHOTO_PIXELS = 24_000_000;
export const MAX_PHOTO_SIDE = 8192;
export const photoTypes = ['image/jpeg', 'image/png', 'image/webp'];
export interface ValidatedPhoto { bytes: Buffer; mime: 'image/webp'; width: number; height: number; contentHash: string }
// Only bytes enter the decoder. Never accept a caller-controlled filesystem path.
export async function validatePhoto(bytes: Buffer, claimedType: string): Promise<ValidatedPhoto> {
  if (!photoTypes.includes(claimedType)) throw new DomainError('Choose a JPEG, PNG or WebP photo.', 415);
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new DomainError('The photo is empty or unreadable.');
  if (bytes.length > MAX_PHOTO_BYTES) throw new DomainError('Photos must be 5 MB or smaller.', 413);
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PHOTO_PIXELS });
    const info = await decoder.metadata();
    const actualType = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string, string>)[info.format ?? ''];
    if (!actualType || actualType !== claimedType) throw new DomainError('The photo bytes do not match its JPEG, PNG or WebP type.');
    if (!info.width || !info.height || info.width > MAX_PHOTO_SIDE || info.height > MAX_PHOTO_SIDE || info.width * info.height > MAX_PHOTO_PIXELS) throw new DomainError('Use a photo up to 24 megapixels and 8192 pixels per side.');
    if ((info.pages ?? 1) > 1) throw new DomainError('Choose a still photo rather than an animated image.');
    // Force complete pixel decoding before saving. Normalize orientation and omit EXIF/GPS metadata.
    const decoded = await decoder.rotate().raw().toBuffer({ resolveWithObject: true });
    const normalized = await sharp(decoded.data, { raw: { width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels } })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (normalized.data.length > MAX_PHOTO_BYTES) throw new DomainError('The decoded photo is too large. Choose a smaller photo.', 413);
    return { bytes: normalized.data, mime: 'image/webp', width: normalized.info.width, height: normalized.info.height, contentHash: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('The photo could not be decoded. Use a complete JPEG, PNG or WebP up to 24 megapixels.');
  }
}
