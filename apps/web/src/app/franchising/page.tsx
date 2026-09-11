import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export const metadata: Metadata = {
  title: "Franchising · Mocha House",
  description: "Learn about franchising opportunities with Mocha House.",
};

// Public Franchising landing page (Milestone 8D). Intentionally
// high-level — a functional foundation for future content. No fees,
// royalty rates, investment minimums, earnings claims, territory
// guarantees, or other business/legal terms are stated here; none of that
// has been provided by Mocha House yet.
export default function FranchisingPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-8">
      <PageHeader
        title="Franchising with Mocha House"
        subtitle="Bring the Mocha House experience to your community."
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-text-primary">
          A growing coffeehouse brand
        </h2>
        <p className="text-sm text-text-secondary">
          Mocha House is built around quality coffee, a warm neighborhood
          feel, and consistent day-to-day operations. We&apos;re exploring
          franchising as a way to bring that experience to new communities
          alongside motivated local owners.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-text-primary">
          The opportunity
        </h2>
        <p className="text-sm text-text-secondary">
          As a franchisee, you would operate a Mocha House location using
          our brand, recipes, and operating know-how, backed by ongoing
          support from our team. Specific terms — investment, fees, and
          territory details — are worked out individually with qualified
          candidates as part of our review process.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-text-primary">
          How it works
        </h2>
        <ol className="flex flex-col gap-2 text-sm text-text-secondary">
          <li>
            <span className="font-medium text-text-primary">
              1. Submit an inquiry.
            </span>{" "}
            Tell us a bit about yourself and the market you&apos;re
            interested in.
          </li>
          <li>
            <span className="font-medium text-text-primary">
              2. We review it.
            </span>{" "}
            Our team looks at every inquiry and reaches out to promising
            candidates.
          </li>
          <li>
            <span className="font-medium text-text-primary">
              3. We talk it through.
            </span>{" "}
            If it looks like a fit, we&apos;ll schedule a conversation to
            learn more about each other.
          </li>
        </ol>
      </section>

      <Card tone="subtle" className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">
          Interested in bringing Mocha House to your area? Start with a
          short inquiry — it only takes a few minutes.
        </p>
        <Link
          href="/franchising/inquiry"
          className="flex min-h-11 items-center justify-center self-start rounded-xl bg-status-success/10 px-4 py-2 text-base font-semibold text-status-success"
        >
          Submit a franchise inquiry
        </Link>
      </Card>
    </main>
  );
}
