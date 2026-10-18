import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { InquiryForm } from "./InquiryForm";
import { getPublishedFranchisingContent, getStorefrontFeatures } from "@/lib/api";
import { notFound } from "next/navigation";
import { pageTitle, requireStorefrontProfile } from "@/lib/storefront-profile";
import { FeatureUnavailable } from "@/components/FeatureUnavailable";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const profile = await requireStorefrontProfile();
  return profile.presentation === "legacy"
    ? {
        title: "Franchise Inquiry · Mocha House",
        description: "Submit a franchise inquiry to Mocha House.",
      }
    : { title: pageTitle(profile, "Franchise Inquiry") };
}

// Public franchise inquiry form (Milestone 8D). No account, no file
// upload, no inquiry id shown on success.
export default async function FranchisingInquiryPage() {
  // SC2b — this business does not offer franchising (the API refuses an
  // inquiry regardless; this only avoids offering a form that can't work).
  const [features, profile, cms] = await Promise.all([
    getStorefrontFeatures(),
    requireStorefrontProfile(),
    getPublishedFranchisingContent(),
  ]);
  const legacy = profile.presentation === "legacy";
  // SC4f-3b (J3) — only a business that published its own franchising
  // content (or Mocha House) offers the inquiry form.
  if (!cms && !legacy) notFound();
  if (features?.franchising === false) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Franchise Inquiry" />
        <FeatureUnavailable message="Franchising inquiries aren't available here right now." />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-1">
        <Link
          href="/franchising"
          className="text-xs text-text-muted underline underline-offset-2"
        >
          Back to Franchising
        </Link>
        <PageHeader
          title="Franchise Inquiry"
          subtitle={
            legacy
              ? "Tell us a little about yourself and where you're interested in opening a Mocha House."
              : "Tell us a little about yourself and where you're interested."
          }
        />
      </div>

      <InquiryForm businessName={profile.businessName} legacy={legacy} />
    </main>
  );
}
