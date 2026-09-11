import type { Metadata } from "next";
import Link from "next/link";
import type { FranchisingPageContent } from "@mocha-house/contracts";
import { getPublishedFranchisingContent } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export const dynamic = "force-dynamic";

const DEFAULT_TITLE = "Franchising · Mocha House";
const DEFAULT_DESCRIPTION =
  "Learn about franchising opportunities with Mocha House.";

// The current hard-coded content — used whenever the CMS has nothing
// published for "franchising" (no row, draft-only, or any fetch/API
// failure). CMS failure must never break this page.
const FALLBACK_CONTENT: FranchisingPageContent = {
  intro: {
    heading: "A growing coffeehouse brand",
    body: "Mocha House is built around quality coffee, a warm neighborhood feel, and consistent day-to-day operations. We're exploring franchising as a way to bring that experience to new communities alongside motivated local owners.",
  },
  opportunity: {
    heading: "The opportunity",
    body: "As a franchisee, you would operate a Mocha House location using our brand, recipes, and operating know-how, backed by ongoing support from our team. Specific terms — investment, fees, and territory details — are worked out individually with qualified candidates as part of our review process.",
  },
  process: {
    heading: "How it works",
    steps: [
      {
        title: "1. Submit an inquiry.",
        body: "Tell us a bit about yourself and the market you're interested in.",
      },
      {
        title: "2. We review it.",
        body: "Our team looks at every inquiry and reaches out to promising candidates.",
      },
      {
        title: "3. We talk it through.",
        body: "If it looks like a fit, we'll schedule a conversation to learn more about each other.",
      },
    ],
  },
  cta: {
    heading: "",
    body: "Interested in bringing Mocha House to your area? Start with a short inquiry — it only takes a few minutes.",
    buttonLabel: "Submit a franchise inquiry",
  },
  seo: { pageTitle: null, metaDescription: null },
};

export async function generateMetadata(): Promise<Metadata> {
  const content = await getPublishedFranchisingContent();
  return {
    title: content?.seo.pageTitle ?? DEFAULT_TITLE,
    description: content?.seo.metaDescription ?? DEFAULT_DESCRIPTION,
  };
}

// Public Franchising landing page (Milestone 8D content, Milestone 8E CMS
// integration). Layout and components stay code-owned; only the text
// (intro, opportunity, process steps, CTA copy) is CMS-managed. The CTA's
// destination is always /franchising/inquiry — never CMS-controlled.
export default async function FranchisingPage() {
  const cms = await getPublishedFranchisingContent();
  const content = cms ?? FALLBACK_CONTENT;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-8">
      <PageHeader
        title="Franchising with Mocha House"
        subtitle="Bring the Mocha House experience to your community."
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-text-primary">
          {content.intro.heading}
        </h2>
        <p className="whitespace-pre-wrap text-sm text-text-secondary">
          {content.intro.body}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-text-primary">
          {content.opportunity.heading}
        </h2>
        <p className="whitespace-pre-wrap text-sm text-text-secondary">
          {content.opportunity.body}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-text-primary">
          {content.process.heading}
        </h2>
        <ol className="flex flex-col gap-2 text-sm text-text-secondary">
          {content.process.steps.map((step, index) => (
            <li key={index}>
              <span className="font-medium text-text-primary">
                {step.title}
              </span>{" "}
              {step.body}
            </li>
          ))}
        </ol>
      </section>

      <Card tone="subtle" className="flex flex-col gap-3">
        {content.cta.heading ? (
          <p className="text-base font-semibold text-text-primary">
            {content.cta.heading}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap text-sm text-text-secondary">
          {content.cta.body}
        </p>
        <Link
          href="/franchising/inquiry"
          className="flex min-h-11 items-center justify-center self-start rounded-xl bg-status-success/10 px-4 py-2 text-base font-semibold text-status-success"
        >
          {content.cta.buttonLabel}
        </Link>
      </Card>
    </main>
  );
}
