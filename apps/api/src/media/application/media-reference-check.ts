import type { HomePageContent } from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';

// Milestone 8F — protects Admin from breaking the live website by
// deactivating an image that a CMS page still points at. Checks the ONE
// known CMS reference to a media asset today: Home's
// hero.backgroundImageId, in BOTH draftContent and publishedContent. As
// more CMS pages gain media references, extend this function — it stays a
// narrow, explicit check rather than a generic JSON-tree scan.
export async function isMediaAssetReferenced(
  prisma: PrismaService,
  mediaAssetId: string,
): Promise<boolean> {
  const home = await prisma.cmsPage.findUnique({ where: { key: 'home' } });
  if (!home) {
    return false;
  }
  const draft = home.draftContent as unknown as HomePageContent | null;
  const published = home.publishedContent as unknown as HomePageContent | null;
  return (
    draft?.hero?.backgroundImageId === mediaAssetId ||
    published?.hero?.backgroundImageId === mediaAssetId
  );
}
