import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { PublicHomePageContent } from "@mocha-house/contracts";
import { getPublishedHomeContent } from "@/lib/api";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";

export const dynamic = "force-dynamic";

const DEFAULT_TITLE = "Mocha House";
const DEFAULT_DESCRIPTION =
  "Freshly brewed coffee and a warm neighborhood feel, right in your community.";

// The safe, code-defined fallback — used whenever nothing has ever been
// published for "home" (no row, draft-only) or the content API is
// unreachable/invalid. CMS failure must never break this page.
const FALLBACK_CONTENT: PublicHomePageContent = {
  hero: {
    headline: "Welcome to Mocha House",
    supportingText: DEFAULT_DESCRIPTION,
    buttonLabel: "Order Online",
    backgroundImageUrl: null,
  },
  featuredProducts: {
    heading: "Fan Favorites",
    products: [],
  },
  seo: { pageTitle: null, metaDescription: null },
};

export async function generateMetadata(): Promise<Metadata> {
  const content = await getPublishedHomeContent();
  return {
    title: content?.seo.pageTitle ?? DEFAULT_TITLE,
    description: content?.seo.metaDescription ?? DEFAULT_DESCRIPTION,
  };
}

// Public Home page (Milestone 8F). Layout/components stay code-owned; the
// Hero text/image and Featured Products selection are CMS-managed
// (Admin → Content → Home). The CTA always links to online ordering — that
// destination is never CMS-controlled. Featured Products are resolved
// server-side from the authoritative catalog (see HomeContentPublicService)
// — this page never invents product data.
export default async function HomePage() {
  const cms = await getPublishedHomeContent();
  const content = cms ?? FALLBACK_CONTENT;

  return (
    <main className="flex flex-1 flex-col">
      <section className="relative flex min-h-[420px] flex-col items-center justify-center gap-4 overflow-hidden bg-surface-subtle px-6 py-20 text-center sm:min-h-[520px]">
        {content.hero.backgroundImageUrl ? (
          <Image
            src={content.hero.backgroundImageUrl}
            alt=""
            fill
            priority
            className="object-cover"
          />
        ) : null}
        <div className="relative flex flex-col items-center gap-4">
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-text-primary sm:text-5xl">
            {content.hero.headline}
          </h1>
          <p className="max-w-xl text-base text-text-secondary sm:text-lg">
            {content.hero.supportingText}
          </p>
          <Link
            href="/order/location"
            className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-6 py-3 text-base font-semibold text-status-success"
          >
            {content.hero.buttonLabel}
          </Link>
        </div>
      </section>

      {content.featuredProducts.products.length > 0 ? (
        <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-12">
          <h2 className="text-2xl font-semibold text-text-primary">
            {content.featuredProducts.heading}
          </h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {content.featuredProducts.products.map((product) => (
              <li key={product.id}>
                <Card className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-text-primary">
                    {product.name}
                  </span>
                  <span className="text-sm text-text-secondary">
                    {formatPrice(product.basePrice, product.currency)}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
