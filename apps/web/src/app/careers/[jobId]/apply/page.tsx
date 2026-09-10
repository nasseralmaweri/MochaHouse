import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicJobOpening } from "@/lib/api";
import {
  employmentTypeLabel,
  jobLocationLabelFromName,
} from "@/lib/admin/careers";
import { PageHeader } from "@/components/PageHeader";
import { ApplyForm } from "./ApplyForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): Promise<Metadata> {
  const { jobId } = await params;
  const job = await getPublicJobOpening(jobId);
  return {
    title: job
      ? `Apply · ${job.title} · Careers · Mocha House`
      : "Careers · Mocha House",
  };
}

// Public application form (Milestone 8C). The job must currently be publicly
// visible or the API returns 404 → notFound(). No account, no file upload,
// no application id shown on success.
export default async function ApplyPage({
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
          href={`/careers/${job.id}`}
          className="text-xs text-text-muted underline underline-offset-2"
        >
          Back to the job description
        </Link>
        <PageHeader
          title={`Apply: ${job.title}`}
          subtitle={`${jobLocationLabelFromName(job.locationName)} · ${employmentTypeLabel(
            job.employmentType,
          )}`}
        />
      </div>

      <ApplyForm jobId={job.id} jobTitle={job.title} />
    </main>
  );
}
