import { Controller, Get, Param } from '@nestjs/common';
import { CmsContentPublicService } from '../application/cms-content-public.service';
import { HomeContentPublicService } from '../application/home-content-public.service';

// The PUBLIC CMS content API. No authentication.
//   GET /api/v1/content/:pageKey — published content only.
// An unknown key, a key with no row, or a key never published are all 404
// alike; draft content is never reachable here. "home" is resolved to a
// richer response (image URL + full product data, see
// HomeContentPublicService) since its content references other domain
// records by id — every other key returns its content verbatim.
@Controller('api/v1/content')
export class CmsController {
  constructor(
    private readonly content: CmsContentPublicService,
    private readonly homeContent: HomeContentPublicService,
  ) {}

  @Get(':pageKey')
  getPublished(@Param('pageKey') pageKey: string) {
    if (pageKey === 'home') {
      return this.homeContent.getPublished();
    }
    return this.content.getPublished(pageKey);
  }
}
