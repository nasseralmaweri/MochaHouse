import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MediaStorage } from './media-storage';

// Milestone 8F — the production MediaStorage. Credentials are resolved
// through the normal AWS SDK provider chain (environment variables,
// shared config/credentials files, or an IAM role) — this class never
// reads or stores a credential itself. Configuration is read lazily (not
// in the constructor) so this provider can be registered in every
// environment without requiring AWS configuration to exist — it only
// throws if it is actually asked to store or resolve something while
// MEDIA_STORAGE_PROVIDER=s3 is active without a bucket configured.
@Injectable()
export class S3MediaStorage implements MediaStorage {
  private readonly logger = new Logger(S3MediaStorage.name);
  private client: S3Client | null = null;

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: process.env.MEDIA_S3_REGION ?? process.env.AWS_REGION,
      });
    }
    return this.client;
  }

  private getBucket(): string {
    const bucket = process.env.MEDIA_S3_BUCKET;
    if (!bucket) {
      throw new Error(
        'MEDIA_S3_BUCKET is not set. Required when MEDIA_STORAGE_PROVIDER=s3.',
      );
    }
    return bucket;
  }

  private publicBaseUrl(): string {
    const base = process.env.MEDIA_PUBLIC_BASE_URL;
    if (!base) {
      throw new Error(
        'MEDIA_PUBLIC_BASE_URL is not set. Required when MEDIA_STORAGE_PROVIDER=s3.',
      );
    }
    return base.replace(/\/+$/, '');
  }

  async put(input: {
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.getBucket(),
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  resolvePublicUrl(objectKey: string): string {
    return `${this.publicBaseUrl()}/${objectKey}`;
  }

  async remove(objectKey: string): Promise<void> {
    try {
      await this.getClient().send(
        new DeleteObjectCommand({ Bucket: this.getBucket(), Key: objectKey }),
      );
    } catch (error) {
      this.logger.warn(
        `best-effort cleanup failed for ${objectKey}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
