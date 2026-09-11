import { BadRequestException } from '@nestjs/common';
import type { CmsPageKey, FranchisingPageContent } from '@mocha-house/contracts';
import {
  CMS_BODY_MAX_LENGTH,
  CMS_BUTTON_LABEL_MAX_LENGTH,
  CMS_PAGE_KEYS,
  CMS_PROCESS_STEPS_MAX,
  CMS_PROCESS_STEPS_MIN,
  CMS_SEO_DESCRIPTION_MAX_LENGTH,
  CMS_SEO_TITLE_MAX_LENGTH,
  CMS_TEXT_MAX_LENGTH,
} from '@mocha-house/contracts';

// Milestone 8E — the CMS page registry. A small, CODE-DEFINED vocabulary
// of manageable page keys (CMS_PAGE_KEYS) — NOT arbitrary page creation.
// Each entry owns its default content (what a never-edited page shows) and
// its own structural validator (every field is plain, bounded text — no
// HTML, no arbitrary URLs; a step or section is either present in full or
// rejected). A key outside this registry is always a 404, never a 500.

export interface CmsPageRegistryEntry {
  key: CmsPageKey;
  title: string;
  defaultContent: FranchisingPageContent;
  // Throws BadRequestException on any structural problem. Returns a fully
  // normalized (trimmed) content object on success.
  validate: (raw: unknown) => FranchisingPageContent;
  // The top-level field keys that differ between two content objects —
  // used ONLY to name what changed in the audit event, never the values.
  changedFieldKeys: (
    before: FranchisingPageContent | null,
    after: FranchisingPageContent,
  ) => string[];
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

function object(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException(`${field} is required.`);
  }
  return raw as Record<string, unknown>;
}

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

function validateProcess(
  raw: unknown,
): FranchisingPageContent['process'] {
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

function validateSeo(raw: unknown): FranchisingPageContent['seo'] {
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

// Shallow top-level diff — enough to name "intro" / "process" / "seo" etc.
// in the audit without ever touching field values.
function shallowChangedKeys(
  before: FranchisingPageContent | null,
  after: FranchisingPageContent,
): string[] {
  const keys = Object.keys(after) as (keyof FranchisingPageContent)[];
  if (!before) {
    return keys;
  }
  return keys.filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
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

export const CMS_PAGE_REGISTRY: Record<CmsPageKey, CmsPageRegistryEntry> = {
  franchising: {
    key: 'franchising',
    title: 'Franchising',
    defaultContent: FRANCHISING_DEFAULT_CONTENT,
    validate: validateFranchisingContent,
    changedFieldKeys: shallowChangedKeys,
  },
};

export function getRegistryEntry(key: string): CmsPageRegistryEntry | null {
  if ((CMS_PAGE_KEYS as readonly string[]).includes(key)) {
    return CMS_PAGE_REGISTRY[key as CmsPageKey];
  }
  return null;
}
