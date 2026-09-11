import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LocalMediaStorage } from '../storage/local-media-storage';

// Milestone 8F — serves object bytes back out when the LOCAL/dev-test
// MediaStorage is active. Public, unauthenticated (images are not
// sensitive; this mirrors what a public S3 bucket / CDN would already do
// in production). When MEDIA_STORAGE_PROVIDER=s3 is active, uploads never
// land in LocalMediaStorage's in-memory map, so this route simply always
// 404s in that environment — the real objects are served directly from
// the bucket/CDN at MEDIA_PUBLIC_BASE_URL instead.
//
// Object keys are always exactly one segment deep — `media/<file>` (see
// MediaAssetsAdminService.upload) — so a fixed two-param route is enough;
// no wildcard routing needed.
@Controller('api/v1/media/objects')
export class MediaObjectsController {
  constructor(private readonly localStorage: LocalMediaStorage) {}

  @Get(':folder/:file')
  get(
    @Param('folder') folder: string,
    @Param('file') file: string,
    @Res() res: Response,
  ) {
    const objectKey = `${folder}/${file}`;
    const found = this.localStorage.get(objectKey);
    if (!found) {
      throw new NotFoundException('Media object not found.');
    }
    res.setHeader('Content-Type', found.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(found.body);
  }
}
