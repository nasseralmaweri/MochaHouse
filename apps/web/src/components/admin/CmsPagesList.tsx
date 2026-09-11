import Link from "next/link";
import type { AdminCmsPageSummary } from "@mocha-house/contracts";
import { cmsStatusLabel, cmsStatusTone, formatCmsDate } from "@/lib/admin/cms";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";

// Admin → Content list (Milestone 8E). For 8E this always shows exactly
// the code-defined registry — currently just "Franchising". No pagination,
// no filtering, no page creation/deletion.
export function CmsPagesList({ pages }: { pages: AdminCmsPageSummary[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {pages.map((page) => (
        <li key={page.key}>
          <Link
            href={`/admin/content/${page.key}`}
            className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Card className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-text-primary">
                  {page.title}
                </span>
                <span className="truncate text-xs text-text-secondary">
                  {page.publishedAt
                    ? `Published ${formatCmsDate(page.publishedAt)}`
                    : "Never published"}
                  {page.updatedAt ? ` · updated ${formatCmsDate(page.updatedAt)}` : ""}
                </span>
              </div>
              <StatusBadge
                label={cmsStatusLabel(page.status, page.hasUnpublishedChanges)}
                tone={cmsStatusTone(page.status, page.hasUnpublishedChanges)}
              />
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
