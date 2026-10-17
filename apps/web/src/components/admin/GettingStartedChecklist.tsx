import type { AdminGettingStartedResponse } from "@mocha-house/contracts";
import {
  SETUP_COMPLETE_TITLE,
  setupCompleteBadge,
  setupCompleteNote,
  gettingStartedProgressLabel,
  gettingStartedSteps,
  nextGettingStartedStep,
} from "@/lib/admin/getting-started";
import { ButtonLink } from "./Button";
import { StatusBadge } from "./StatusBadge";
import { Card } from "@/components/Card";

// SC4d — the getting-started checklist: every step, done or not, with one
// clear action per open step and the overall progress. "Setup complete" is
// always paired with the reminder that the business is not publicly live.
export function GettingStartedChecklist({
  checklist,
}: {
  checklist: AdminGettingStartedResponse;
}) {
  const steps = gettingStartedSteps(checklist);
  const percent = Math.round(
    (checklist.completedCount / checklist.totalCount) * 100,
  );

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-primary">
            {checklist.setupComplete
              ? SETUP_COMPLETE_TITLE
              : gettingStartedProgressLabel(checklist)}
          </span>
          <StatusBadge
            label={
              checklist.setupComplete
                ? setupCompleteBadge(checklist.storefrontLive)
                : "In progress"
            }
            tone={
              !checklist.setupComplete
                ? "warning"
                : checklist.storefrontLive
                  ? "positive"
                  : "neutral"
            }
          />
        </div>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={checklist.totalCount}
          aria-valuenow={checklist.completedCount}
          aria-valuetext={gettingStartedProgressLabel(checklist)}
          className="h-2 w-full overflow-hidden rounded-full bg-surface-subtle"
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${percent}%` }}
          />
        </div>
        {checklist.setupComplete ? (
          <p className="text-sm text-text-secondary">
            {setupCompleteNote(checklist.storefrontLive)}
          </p>
        ) : null}
      </Card>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.key}>
            <Card
              tone={step.done ? "subtle" : "default"}
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    step.done
                      ? "bg-status-success/10 text-status-success"
                      : "bg-surface-subtle text-text-secondary"
                  }`}
                >
                  {step.done ? "✓" : index + 1}
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-text-primary">
                    {step.title}
                    <span className="sr-only">
                      {step.done ? " (done)" : " (to do)"}
                    </span>
                  </span>
                  <span className="text-sm text-text-secondary">
                    {step.description}
                  </span>
                </div>
              </div>
              {step.action ? (
                <ButtonLink
                  href={step.action.href}
                  className="w-full shrink-0 sm:w-auto"
                >
                  {step.action.label}
                </ButtonLink>
              ) : null}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}

// The compact version for the Overview page: progress and the next step.
export function GettingStartedSummary({
  checklist,
}: {
  checklist: AdminGettingStartedResponse;
}) {
  const next = nextGettingStartedStep(checklist);
  return (
    <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">
          Finish setting up your business
        </span>
        <span className="text-sm text-text-secondary">
          {gettingStartedProgressLabel(checklist)}
          {next ? ` · Next: ${next.title}` : ""}
        </span>
      </div>
      <ButtonLink
        href="/admin/getting-started"
        variant="primary"
        className="w-full shrink-0 sm:w-auto"
      >
        Continue setup
      </ButtonLink>
    </Card>
  );
}
