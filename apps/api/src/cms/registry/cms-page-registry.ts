import { BadRequestException } from '@nestjs/common';
import type {
  CmsPageContent,
  CmsPageKey,
  FranchisingPageContent,
  HomePageContent,
} from '@mocha-house/contracts';
import {
  CMS_BODY_MAX_LENGTH,
  CMS_BUTTON_LABEL_MAX_LENGTH,
  CMS_FEATURED_PRODUCTS_MAX,
  CMS_PAGE_KEYS,
  CMS_PROCESS_STEPS_MAX,
  CMS_PROCESS_STEPS_MIN,
  CMS_SEO_DESCRIPTION_MAX_LENGTH,
  CMS_SEO_TITLE_MAX_LENGTH,
  CMS_TEXT_MAX_LENGTH,
} from '@mocha-house/contracts';
import type { PrismaService } from '../../prisma/prisma.service';

// Milestone 8E/8F — the CMS page registry. A small, CODE-DEFINED vocabulary
// of manageable page keys (CMS_PAGE_KEYS) — NOT arbitrary page creation.
// Each entry owns its default content (what a never-edited page shows), its
// own structural validator (every field is plain, bounded text — no HTML,
// no arbitrary URLs; a section is either present in full or rejected), and
// — new in 8F — an optional DB-backed reference validator for entries that
// point at other domain records (Home's hero image and featured products).
// A key outside this registry is always a 404, never a 500.

export interface CmsPageRegistryEntry {
  key: CmsPageKey;
  title: string;
  defaultContent: CmsPageContent;
  // Throws BadRequestException on any structural problem. Returns a fully
  // normalized (trimmed) content object on success.
  validate: (raw: unknown) => CmsPageContent;
  // The top-level field keys that differ between two content objects —
  // used ONLY to name what changed in the audit event, never the values.
  changedFieldKeys: (
    before: CmsPageContent | null,
    after: CmsPageContent,
  ) => string[];
  // Optional cross-reference check against other domain tables (media,
  // products, …), run AFTER `validate()` on both save-draft and publish.
  // Throws BadRequestException — invalid Admin references are never
  // silently persisted.
  validateReferences?: (
    content: CmsPageContent,
    prisma: PrismaService,
  ) => Promise<void>;
}

function text(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new BadRequestException(`${field} is required.`);
  }
  const value = raw.trim();
  if (value.length > max) {
    throw new BadRequestException(`${field} must be at most ${max} characters.`);
  }
  return value;
}

function optionalText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new BadRequestException(`${field} isn't valid.`);
  }
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  if (value.length > max) {
    throw new BadRequestException(`${field} must be at most ${max} characters.`);
  }
  return value;
}

// A referenced record id (media asset id, product id, …) — a plain
// non-empty bounded string. Existence/active-state is checked separately
// by `validateReferences`, never here.
function optionalId(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 100) {
    throw new BadRequestException(`${field} isn't valid.`);
  }
  return raw.trim();
}

function object(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException(`${field} is required.`);
  }
  return raw as Record<string, unknown>;
}

function validateSeo(raw: unknown): { pageTitle: string | null; metaDescription: string | null } {
  // seo is optional as a whole — an absent section means "use defaults".
  if (raw === undefined || raw === null) {
    return { pageTitle: null, metaDescription: null };
  }
  const section = object(raw, 'seo');
  return {
    pageTitle: optionalText(section.pageTitle, 'seo page title', CMS_SEO_TITLE_MAX_LENGTH),
    metaDescription: optionalText(
      section.metaDescription,
      'seo meta description',
      CMS_SEO_DESCRIPTION_MAX_LENGTH,
    ),
  };
}

// Shallow top-level diff — enough to name "intro" / "hero" / "seo" etc. in
// the audit without ever touching field values. Works for any of the
// (structurally similar, flat-object) content shapes.
function shallowChangedKeys(
  before: CmsPageContent | null,
  after: CmsPageContent,
): string[] {
  const afterRecord = after as unknown as Record<string, unknown>;
  const beforeRecord = before as unknown as Record<string, unknown> | null;
  const keys = Object.keys(afterRecord);
  if (!beforeRecord) {
    return keys;
  }
  return keys.filter(
    (key) => JSON.stringify(beforeRecord[key]) !== JSON.stringify(afterRecord[key]),
  );
}

// --- franchising -------------------------------------------------------

function validateHeadingBody(
  raw: unknown,
  field: string,
): { heading: string; body: string } {
  const section = object(raw, field);
  return {
    heading: text(section.heading, `${field} heading`, CMS_TEXT_MAX_LENGTH),
    body: text(section.body, `${field} body`, CMS_BODY_MAX_LENGTH),
  };
}

function validateProcess(raw: unknown): FranchisingPageContent['process'] {
  const section = object(raw, 'process');
  const heading = text(section.heading, 'process heading', CMS_TEXT_MAX_LENGTH);

  if (!Array.isArray(section.steps)) {
    throw new BadRequestException('process steps are required.');
  }
  if (
    section.steps.length < CMS_PROCESS_STEPS_MIN ||
    section.steps.length > CMS_PROCESS_STEPS_MAX
  ) {
    throw new BadRequestException(
      `process must have between ${CMS_PROCESS_STEPS_MIN} and ${CMS_PROCESS_STEPS_MAX} steps.`,
    );
  }
  const steps = section.steps.map((rawStep: unknown, index: number) => {
    const step = object(rawStep, `process step ${index + 1}`);
    return {
      title: text(step.title, `process step ${index + 1} title`, CMS_TEXT_MAX_LENGTH),
      body: text(step.body, `process step ${index + 1} body`, CMS_BODY_MAX_LENGTH),
    };
  });

  return { heading, steps };
}

function validateCta(raw: unknown): FranchisingPageContent['cta'] {
  const section = object(raw, 'cta');
  return {
    heading: text(section.heading, 'cta heading', CMS_TEXT_MAX_LENGTH),
    body: text(section.body, 'cta body', CMS_BODY_MAX_LENGTH),
    buttonLabel: text(
      section.buttonLabel,
      'cta button label',
      CMS_BUTTON_LABEL_MAX_LENGTH,
    ),
  };
}

function validateFranchisingContent(raw: unknown): FranchisingPageContent {
  const root = object(raw, 'content');
  return {
    intro: validateHeadingBody(root.intro, 'intro'),
    opportunity: validateHeadingBody(root.opportunity, 'opportunity'),
    process: validateProcess(root.process),
    cta: validateCta(root.cta),
    seo: validateSeo(root.seo),
  };
}

const FRANCHISING_DEFAULT_CONTENT: FranchisingPageContent = {
  intro: {
    heading: 'A growing coffeehouse brand',
    body: 'Mocha House is built around quality coffee, a warm neighborhood feel, and consistent day-to-day operations. We’re exploring franchising as a way to bring that experience to new communities alongside motivated local owners.',
  },
  opportunity: {
    heading: 'The opportunity',
    body: 'As a franchisee, you would operate a Mocha House location using our brand, recipes, and operating know-how, backed by ongoing support from our team. Specific terms — investment, fees, and territory details — are worked out individually with qualified candidates as part of our review process.',
  },
  process: {
    heading: 'How it works',
    steps: [
      {
        title: 'Submit an inquiry.',
        body: "Tell us a bit about yourself and the market you're interested in.",
      },
      {
        title: 'We review it.',
        body: 'Our team looks at every inquiry and reaches out to promising candidates.',
      },
      {
        title: 'We talk it through.',
        body: "If it looks like a fit, we'll schedule a conversation to learn more about each other.",
      },
    ],
  },
  cta: {
    heading: 'Interested?',
    body: "Interested in bringing Mocha House to your area? Start with a short inquiry — it only takes a few minutes.",
    buttonLabel: 'Submit a franchise inquiry',
  },
  seo: {
    pageTitle: null,
    metaDescription: null,
  },
};

// --- home (Milestone 8F) ------------------------------------------------
// The hero's CTA destination stays code-owned (no URL field, same rule as
// Franchising's CTA). `backgroundImageId` and `featuredProducts.productIds`
// are references only — no product/media data is ever duplicated into
// content; `validateHomeReferences` confirms each reference actually
// exists and is active before it can be saved or published.

function validateHero(raw: unknown): HomePageContent['hero'] {
  const section = object(raw, 'hero');
  return {
    headline: text(section.headline, 'hero headline', CMS_TEXT_MAX_LENGTH),
    supportingText: text(
      section.supportingText,
      'hero supporting text',
      CMS_BODY_MAX_LENGTH,
    ),
    buttonLabel: text(section.buttonLabel, 'hero button label', CMS_BUTTON_LABEL_MAX_LENGTH),
    backgroundImageId: optionalId(section.backgroundImageId, 'hero background image'),
  };
}

function validateFeaturedProducts(raw: unknown): HomePageContent['featuredProducts'] {
  const section = object(raw, 'featuredProducts');
  const heading = text(
    section.heading,
    'featured products heading',
    CMS_TEXT_MAX_LENGTH,
  );

  if (!Array.isArray(section.productIds)) {
    throw new BadRequestException('featured products productIds are required.');
  }
  if (section.productIds.length > CMS_FEATURED_PRODUCTS_MAX) {
    throw new BadRequestException(
      `featured products can have at most ${CMS_FEATURED_PRODUCTS_MAX} products.`,
    );
  }
  const productIds = section.productIds.map((rawId: unknown, index: number) => {
    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      throw new BadRequestException(`featured product ${index + 1} id isn't valid.`);
    }
    return rawId.trim();
  });
  if (new Set(productIds).size !== productIds.length) {
    throw new BadRequestException('featured products cannot list the same product twice.');
  }

  return { heading, productIds };
}

function validateHomeContent(raw: unknown): HomePageContent {
  const root = object(raw, 'content');
  return {
    hero: validateHero(root.hero),
    featuredProducts: validateFeaturedProducts(root.featuredProducts),
    seo: validateSeo(root.seo),
  };
}

async function validateHomeReferences(
  rawContent: CmsPageContent,
  prisma: PrismaService,
): Promise<void> {
  const content = rawContent as HomePageContent;

  if (content.hero.backgroundImageId) {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: content.hero.backgroundImageId },
      select: { isActive: true },
    });
    if (!asset || !asset.isActive) {
      throw new BadRequestException(
        "The selected hero background image no longer exists or is inactive. Choose a different image and save again.",
      );
    }
  }

  if (content.featuredProducts.productIds.length > 0) {
    const products = await prisma.product.findMany({
      where: { id: { in: content.featuredProducts.productIds }, isActive: true },
      select: { id: true },
    });
    const foundIds = new Set(products.map((product) => product.id));
    const missing = content.featuredProducts.productIds.some((id) => !foundIds.has(id));
    if (missing) {
      throw new BadRequestException(
        'One or more featured products no longer exist or are inactive. Update the selection and save again.',
      );
    }
  }
}

const HOME_DEFAULT_CONTENT: HomePageContent = {
  hero: {
    headline: 'Welcome to Mocha House',
    supportingText:
      'Freshly brewed coffee and a warm neighborhood feel, right in your community.',
    buttonLabel: 'Order Online',
    backgroundImageId: null,
  },
  featuredProducts: {
    heading: 'Fan Favorites',
    productIds: [],
  },
  seo: {
    pageTitle: null,
    metaDescription: null,
  },
};

export const CMS_PAGE_REGISTRY: Record<CmsPageKey, CmsPageRegistryEntry> = {
  franchising: {
    key: 'franchising',
    title: 'Franchising',
    defaultContent: FRANCHISING_DEFAULT_CONTENT,
    validate: validateFranchisingContent,
    changedFieldKeys: shallowChangedKeys,
  },
  home: {
    key: 'home',
    title: 'Home',
    defaultContent: HOME_DEFAULT_CONTENT,
    validate: validateHomeContent,
    changedFieldKeys: shallowChangedKeys,
    validateReferences: validateHomeReferences,
  },
};

export function getRegistryEntry(key: string): CmsPageRegistryEntry | null {
  if ((CMS_PAGE_KEYS as readonly string[]).includes(key)) {
    return CMS_PAGE_REGISTRY[key as CmsPageKey];
  }
  return null;
}
