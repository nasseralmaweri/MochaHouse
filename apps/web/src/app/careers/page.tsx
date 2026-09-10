import type { Metadata } from "next";
import Link from "next/link";
import { getPublicJobOpenings } from "@/lib/api";
import {
  employmentTypeLabel,
  jobLocationLabelFromName,
} from "@/lib/admin/careers";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export const metadata: Metadata = {
  title: "Careers · Mocha House",
  description: "Open positions at Mocha House.",
};

export const dynamic = "force-dynamic";

// Public Careers → Job Openings (Milestone 8B). Lists only currently
// published, publicly-visible openings. Applying online is not part of this
// release.
export default async function CareersPage() {
  let jobs: Awaited<ReturnType<typeof getPublicJobOpenings>>["jobs"] = [];
  let failed = false;
  try {
    jobs = (await getPublicJobOpenings()).jobs;
  } catch {
    failed = true;
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Careers"
        subtitle="Open positions at Mocha House."
      />

      {failed ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          We couldn&apos;t load open positions right now. Please try again later.
        </Card>
      ) : jobs.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          There are no open positions at the moment. Please check back soon.
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/careers/${job.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex flex-col gap-1">
                  <span className="text-base font-semibold text-text-primary">
                    {job.title}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {jobLocationLabelFromName(job.locationName)} ·{" "}
                    {employmentTypeLabel(job.employmentType)}
                  </span>
                  <span className="text-sm text-text-secondary">
                    {job.summary}
                  </span>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
