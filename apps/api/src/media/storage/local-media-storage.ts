import { Injectable } from '@nestjs/common';
import type { MediaStorage } from './media-storage';

// Milestone 8F — the dev/test MediaStorage. Keeps uploaded bytes in
// process memory (no filesystem, no external service) so that running
// tests, builds, or ordinary local development NEVER requires real AWS
// credentials. Bytes are served back out by `MediaObjectsController`
// (public, unauthenticated — this is the "storage" layer, images are not
// sensitive). This is the default provider unless
// MEDIA_STORAGE_PROVIDER=s3 is explicitly set.
@Injectable()
export class LocalMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  private publicBaseUrl(): string {
    return (
      process.env.MEDIA_PUBLIC_BASE_URL ??
      'http://localhost:3001/api/v1/media/objects'
    ).replace(/\/+$/, '');
  }

  async put(input: {
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    this.objects.set(input.objectKey, {
      body: input.body,
      contentType: input.contentType,
    });
  }

  resolvePublicUrl(objectKey: string): string {
    return `${this.publicBaseUrl()}/${objectKey}`;
  }

  async remove(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  // Local-only accessor used by MediaObjectsController to serve bytes back
  // out. Not part of the shared MediaStorage interface — S3 doesn't need
  // it (the bucket / CDN serves objects directly).
  get(objectKey: string): { body: Buffer; contentType: string } | null {
    return this.objects.get(objectKey) ?? null;
  }
}
