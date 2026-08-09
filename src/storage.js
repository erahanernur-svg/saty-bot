import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

/**
 * Cloudflare R2 storage (primary image store).
 *
 * Credentials live only in the server environment (.env) — never in the
 * browser. Uploads go to the bot over /api/upload; the bot writes the object
 * to R2 and hands the client a public URL routed through Cloudflare Cache
 * (R2_PUBLIC_URL). Heavy lifting is done server-side so no secret ever reaches
 * the frontend.
 */

const R2_ENDPOINT = (process.env.R2_ENDPOINT || '').trim();
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = (process.env.R2_BUCKET_NAME || '').trim();
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '');

function client() {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

/** True when R2 is fully configured in the server environment. */
export function r2Configured() {
  return !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);
}

/**
 * Upload a Buffer to R2 and return its public delivery URL. Throw on failure —
 * callers must decide whether to fail the whole request or fall back.
 */
export async function uploadToR2({ buffer, name = '', contentType = '' }) {
  const clientInstance = client();
  if (!clientInstance) throw new Error('R2 not configured');

  const safeExt = (() => {
    const dot = name.lastIndexOf('.');
    let ext = dot >= 0 ? name.slice(dot + 1) : '';
    ext = ext.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);
    if (!ext) ext = (contentType || '').split('/')[1] || 'jpg';
    if (!ext) ext = 'jpg';
    return ext;
  })();

  const key = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${safeExt}`;

  await clientInstance.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: (contentType || 'image/jpeg').slice(0, 128),
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  return {
    key,
    // Public URL served through Cloudflare Cache. If no public domain is
    // configured, fall back to the raw R2 endpoint path.
    url: R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : key,
  };
}