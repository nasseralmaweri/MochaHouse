import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { InquiryForm } from "./InquiryForm";
import { getStorefrontFeatures } from "@/lib/api";
import { FeatureUnavailable } from "@/components/FeatureUnavailable";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Franchise Inquiry · Mocha House",
  description: "Submit a franchise inquiry to Mocha House.",
};

// Public franchise inquiry form (Milestone 8D). No account, no file
// upload, no inquiry id shown on success.
export default async function FranchisingInquiryPage() {
  // SC2b — this business does not offer franchising (the API refuses an
  // inquiry regardless; this only avoids offering a form that can't work).
  const features = await getStorefrontFeatures();
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
          subtitle="Tell us a little about yourself and where you're interested in opening a Mocha House."
        />
      </div>

      <InquiryForm />
    </main>
  );
}
