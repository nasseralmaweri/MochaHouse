import { Module } from '@nestjs/common';
import { MEDIA_STORAGE } from './media-storage';
import { LocalMediaStorage } from './local-media-storage';
import { S3MediaStorage } from './s3-media-storage';

// Milestone 8F — selects the active MediaStorage implementation from
// MEDIA_STORAGE_PROVIDER ("s3" | anything else, default local). Both
// providers are always registered (S3MediaStorage reads its AWS
// configuration lazily, never in its constructor) so the module boots
// fine in every environment; only the selected one is ever exercised.
// LocalMediaStorage is exported on its own too — MediaObjectsController
// needs its extra `get()` accessor beyond the shared MediaStorage
// interface, to serve bytes back out in dev/test.
@Module({
  providers: [
    LocalMediaStorage,
    S3MediaStorage,
    {
      provide: MEDIA_STORAGE,
      useFactory: (local: LocalMediaStorage, s3: S3MediaStorage) =>
        process.env.MEDIA_STORAGE_PROVIDER === 's3' ? s3 : local,
      inject: [LocalMediaStorage, S3MediaStorage],
    },
  ],
  exports: [MEDIA_STORAGE, LocalMediaStorage],
})
export class MediaStorageModule {}
