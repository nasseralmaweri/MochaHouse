"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminModifierGroupSummary,
  AdminProductModifierGroup,
} from "@mocha-house/contracts";
import {
  attachModifierGroupFromBrowser,
  detachModifierGroupFromBrowser,
  reorderProductModifierGroupsFromBrowser,
  type AdminMutationResult,
} from "@/lib/api-client";
import { moveItem, selectionRuleLabel } from "@/lib/admin/modifiers";
import { Card } from "@/components/Card";
import { Button, ButtonLink, SoftDisabledButton } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { StatusBadge } from "./StatusBadge";

// A product's customizations: which modifier groups customers choose from,
// in order. Groups are shared, so each one says how many products use it
// and links to where it is edited. Removing a group only takes it off this
// product. Without edit access the list is read-only.
export function ProductModifiersEditor({
  productId,
  attached,
  available,
  canEdit,
}: {
  productId: string;
  attached: AdminProductModifierGroup[];
  // Every group of the business (only offered when not yet attached), or
  // null when that list could not be loaded.
  available: AdminModifierGroupSummary[] | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [choice, setChoice] = useState("");

  const attachedIds = new Set(attached.map((group) => group.id));
  const addable = (available ?? []).filter(
    (group) => group.isActive && !attachedIds.has(group.id),
  );

  async function apply(
    change: () => Promise<AdminMutationResult>,
    done: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setStatus(null);
    const result = await change();
    setBusy(false);
    setConfirmingRemove(null);
    if (result.outcome === "success") {
      setStatus(done);
      router.refresh();
      return true;
    }
    setError(
      result.outcome === "forbidden"
        ? "You don't have permission to change this product's customizations."
        : result.outcome === "not-found"
          ? "This product or group no longer exists. Reload the page."
          : result.message,
    );
    return false;
  }

  return (
    <div className="flex flex-col gap-4">
      {attached.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          Customers order this product as it is — no choices yet.
        </Card>
      ) : (
        <ol className="flex flex-col gap-2">
          {attached.map((group, index) => (
            <li key={group.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <span className="flex flex-col gap-0.5">
                    <Link
                      href={`/admin/menu/modifiers/${group.id}`}
                      className="text-base font-medium text-text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {group.name}
                    </Link>
                    <span className="text-sm text-text-secondary">
                      {selectionRuleLabel(group.minSelections, group.maxSelections)}
                      {" · "}
                      {group.activeOptionCount} active option
                      {group.activeOptionCount === 1 ? "" : "s"}
                    </span>
                    {group.productCount > 1 ? (
                      <span className="text-xs text-text-muted">
                        Shared with {group.productCount - 1} other product
                        {group.productCount - 1 === 1 ? "" : "s"}.
                      </span>
                    ) : null}
                  </span>
                  {group.isActive ? null : (
                    <StatusBadge label="Inactive — not shown" tone="neutral" />
                  )}
                </div>

                {canEdit ? (
                  confirmingRemove === group.id ? (
                    <div className="flex flex-col gap-2">
                      <p role="alert" className="text-sm text-status-warning">
                        Remove {group.name} from this product? The group and
                        its options stay available for other products.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <SoftDisabledButton
                          unavailable={busy}
                          onClick={() =>
                            void apply(
                              () =>
                                detachModifierGroupFromBrowser(productId, group.id),
                              `Removed ${group.name}.`,
                            )
                          }
                        >
                          Remove {group.name}
                        </SoftDisabledButton>
                        <SoftDisabledButton
                          variant="secondary"
                          unavailable={busy}
                          onClick={() => setConfirmingRemove(null)}
                        >
                          Keep it
                        </SoftDisabledButton>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <SoftDisabledButton
                        variant="secondary"
                        unavailable={busy || index === 0}
                        onClick={() =>
                          void apply(
                            () =>
                              reorderProductModifierGroupsFromBrowser(
                                productId,
                                moveItem(
                                  attached.map((g) => g.id),
                                  index,
                                  -1,
                                ),
                              ),
                            `Moved ${group.name} up.`,
                          )
                        }
                        aria-label={`Move up: ${group.name}`}
                      >
                        Move up
                      </SoftDisabledButton>
                      <SoftDisabledButton
                        variant="secondary"
                        unavailable={busy || index === attached.length - 1}
                        onClick={() =>
                          void apply(
                            () =>
                              reorderProductModifierGroupsFromBrowser(
                                productId,
                                moveItem(
                                  attached.map((g) => g.id),
                                  index,
                                  1,
                                ),
                              ),
                            `Moved ${group.name} down.`,
                          )
                        }
                        aria-label={`Move down: ${group.name}`}
                      >
                        Move down
                      </SoftDisabledButton>
                      <SoftDisabledButton
                        variant="secondary"
                        unavailable={busy}
                        onClick={() => {
                          setConfirmingRemove(group.id);
                          setError(null);
                          setStatus(null);
                        }}
                        aria-label={`Remove: ${group.name}`}
                      >
                        Remove
                      </SoftDisabledButton>
                    </div>
                  )
                ) : null}
              </Card>
            </li>
          ))}
        </ol>
      )}

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-sm text-status-success">
          {status}
        </p>
      ) : null}

      {canEdit && available === null ? (
        <p role="alert" className="text-sm text-status-warning">
          Couldn&apos;t load the modifier groups you can add just now. Reload
          the page to try again.
        </p>
      ) : canEdit ? (
        addable.length > 0 ? (
          <Card tone="subtle">
            <form
              className="flex flex-col gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                const group = addable.find((g) => g.id === choice);
                if (!group) {
                  setError("Choose a modifier group to add.");
                  return;
                }
                if (
                  await apply(
                    () => attachModifierGroupFromBrowser(productId, group.id),
                    `Added ${group.name}.`,
                  )
                ) {
                  setChoice("");
                }
              }}
            >
              <FormField
                label="Add a modifier group"
                htmlFor={`add-modifier-${productId}`}
                hint="Groups are shared: editing one later changes every product that uses it."
              >
                <select
                  id={`add-modifier-${productId}`}
                  value={choice}
                  onChange={(event) => {
                    setChoice(event.target.value);
                    setError(null);
                  }}
                  className={`${ADMIN_FIELD_CLASS} min-h-11`}
                >
                  <option value="">Choose a group…</option>
                  {addable.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} — {selectionRuleLabel(group.minSelections, group.maxSelections)}
                      {group.activeOptionCount === 0 ? " (no active options yet)" : ""}
                    </option>
                  ))}
                </select>
              </FormField>
              <div>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Add group"}
                </Button>
              </div>
            </form>
          </Card>
        ) : (
          <Card
            tone="subtle"
            className="flex flex-col items-start gap-2 text-sm text-text-secondary"
          >
            <p>
              {(available ?? []).length === 0
                ? "There are no modifier groups yet."
                : "Every active modifier group is already on this product."}
            </p>
            <ButtonLink href="/admin/menu/modifiers/new">
              New modifier group
            </ButtonLink>
          </Card>
        )
      ) : null}
    </div>
  );
}
