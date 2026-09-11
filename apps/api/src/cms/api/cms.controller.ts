import { Controller, Get, Param } from '@nestjs/common';
import { CmsContentPublicService } from '../application/cms-content-public.service';

// The PUBLIC CMS content API. No authentication.
//   GET /api/v1/content/:pageKey — published content only.
// An unknown key, a key with no row, or a key never published are all 404
// alike; draft content is never reachable here.
@Controller('api/v1/content')
export class CmsController {
  constructor(private readonly content: CmsContentPublicService) {}

  @Get(':pageKey')
  getPublished(@Param('pageKey') pageKey: string) {
    return this.content.getPublished(pageKey);
  }
}
