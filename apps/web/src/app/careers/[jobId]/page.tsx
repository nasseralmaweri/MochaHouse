import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicJobOpening } from "@/lib/api";
import {
  employmentTypeLabel,
  jobLocationLabelFromName,
} from "@/lib/admin/careers";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): Promise<Metadata> {
  const { jobId } = await params;
  const job = await getPublicJobOpening(jobId);
  return {
    title: job ? `${job.title} · Careers · Mocha House` : "Careers · Mocha House",
  };
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <p className="whitespace-pre-wrap text-sm text-text-secondary">{body}</p>
    </section>
  );
}

// Public job detail (Milestone 8B). A non-visible job (draft, archived,
// inactive location, unknown) returns 404 from the API → notFound().
export default async function JobOpeningPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const job = await getPublicJobOpening(jobId);
  if (!job) {
    notFound();
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-1">
        <Link
          href="/careers"
          className="text-xs text-text-muted underline underline-offset-2"
        >
          All open positions
        </Link>
        <PageHeader
          title={job.title}
          subtitle={`${jobLocationLabelFromName(job.locationName)} · ${employmentTypeLabel(
            job.employmentType,
          )}`}
        />
      </div>

      <p className="text-sm text-text-primary">{job.summary}</p>

      <Section title="About the role" body={job.description} />
      <Section title="Responsibilities" body={job.responsibilities} />
      <Section title="Qualifications" body={job.qualifications} />

      <Card tone="subtle" className="text-sm text-text-secondary">
        <p className="font-medium text-text-primary">How to apply</p>
        <p>
          Online applications aren&apos;t available yet. To express interest in
          this role, please contact a Mocha House location directly. An online
          application experience is coming soon.
        </p>
      </Card>
    </main>
  );
}
