"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminModifierGroupDetail,
  AdminModifierOption,
} from "@mocha-house/contracts";
import {
  createModifierOptionFromBrowser,
  reorderModifierOptionsFromBrowser,
  updateModifierOptionFromBrowser,
  type AdminMutationResult,
} from "@/lib/api-client";
import {
  moveItem,
  parsePriceAdjustmentInput,
  priceAdjustmentLabel,
} from "@/lib/admin/modifiers";
import { centsToDollarInput } from "@/lib/money";
import { Card } from "@/components/Card";
import { Button, SoftDisabledButton } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { StatusBadge } from "./StatusBadge";

// A modifier group's options: the order customers see them in, each one's
// extra charge and status, and adding new ones. Nothing is ever deleted —
// an option is deactivated instead, and the API refuses a change that would
// leave a product unable to be configured (its message is shown as-is).
// Without edit access the list is read-only.
export function ModifierOptionsEditor({
  group,
  canEdit,
}: {
  group: AdminModifierGroupDetail;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function apply(
    change: () => Promise<AdminMutationResult>,
    done: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setStatus(null);
    const result = await change();
    setBusy(false);
    if (result.outcome === "success") {
      setStatus(done);
      router.refresh();
      return true;
    }
    setError(
      result.outcome === "forbidden"
        ? "You don't have permission to change options."
        : result.outcome === "not-found"
          ? "This option or group no longer exists. Reload the page."
          : result.message,
    );
    return false;
  }

  function move(index: number, delta: -1 | 1) {
    const ids = moveItem(
      group.options.map((option) => option.id),
      index,
      delta,
    );
    const option = group.options[index];
    void apply(
      () => reorderModifierOptionsFromBrowser(group.id, ids),
      `Moved ${option.name} ${delta < 0 ? "up" : "down"}.`,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {group.options.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          No options yet.{canEdit ? " Add the first one below." : ""}
        </Card>
      ) : (
        <ol className="flex flex-col gap-2">
          {group.options.map((option, index) => (
            <li key={option.id}>
              <Card className="flex flex-col gap-3">
                {editingId === option.id ? (
                  <OptionEditForm
                    option={option}
                    busy={busy}
                    onCancel={() => setEditingId(null)}
                    onSave={async (input) => {
                      const ok = await apply(
                        () =>
                          updateModifierOptionFromBrowser(
                            group.id,
                            option.id,
                            input,
                          ),
                        `Saved ${input.name}.`,
                      );
                      if (ok) setEditingId(null);
                    }}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex flex-col gap-0.5">
                      <span className="text-base font-medium text-text-primary">
                        {option.name}
                      </span>
                      <span className="text-sm text-text-secondary">
                        {priceAdjustmentLabel(option.priceAdjustment)}
                      </span>
                    </span>
                    <StatusBadge
                      label={option.isActive ? "Active" : "Inactive"}
                      tone={option.isActive ? "positive" : "neutral"}
                    />
                  </div>
                )}

                {canEdit && editingId !== option.id ? (
                  <div className="flex flex-wrap gap-2">
                    <SoftDisabledButton
                      variant="secondary"
                      unavailable={busy || index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={`Move up: ${option.name}`}
                    >
                      Move up
                    </SoftDisabledButton>
                    <SoftDisabledButton
                      variant="secondary"
                      unavailable={busy || index === group.options.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Move down: ${option.name}`}
                    >
                      Move down
                    </SoftDisabledButton>
                    <SoftDisabledButton
                      variant="secondary"
                      unavailable={busy}
                      onClick={() => {
                        setEditingId(option.id);
                        setError(null);
                        setStatus(null);
                      }}
                      aria-label={`Edit: ${option.name}`}
                    >
                      Edit
                    </SoftDisabledButton>
                    <SoftDisabledButton
                      variant="secondary"
                      unavailable={busy}
                      onClick={() =>
                        void apply(
                          () =>
                            updateModifierOptionFromBrowser(
                              group.id,
                              option.id,
                              { isActive: !option.isActive },
                            ),
                          `${option.name} ${option.isActive ? "deactivated" : "reactivated"}.`,
                        )
                      }
                      aria-label={`${option.isActive ? "Deactivate" : "Reactivate"}: ${option.name}`}
                    >
                      {option.isActive ? "Deactivate" : "Reactivate"}
                    </SoftDisabledButton>
                  </div>
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

      {canEdit ? (
        <AddOptionForm
          busy={busy}
          onAdd={async (input) => {
            setBusy(true);
            setError(null);
            setStatus(null);
            const result = await createModifierOptionFromBrowser(
              group.id,
              input,
            );
            setBusy(false);
            if (result.outcome === "success") {
              setStatus(`Added ${input.name}.`);
              router.refresh();
              return true;
            }
            setError(
              result.outcome === "forbidden"
                ? "You don't have permission to add options."
                : result.outcome === "not-found"
                  ? "This modifier group no longer exists."
                  : result.message,
            );
            return false;
          }}
        />
      ) : null}
    </div>
  );
}

function OptionEditForm({
  option,
  busy,
  onSave,
  onCancel,
}: {
  option: AdminModifierOption;
  busy: boolean;
  onSave: (input: { name: string; priceAdjustment: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(option.name);
  const [price, setPrice] = useState(
    option.priceAdjustment === 0 ? "" : centsToDollarInput(option.priceAdjustment),
  );
  const [error, setError] = useState<string | null>(null);
  const idBase = `option-${option.id}`;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() === "") {
          setError("Enter an option name.");
          return;
        }
        const parsed = parsePriceAdjustmentInput(price);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        setError(null);
        void onSave({ name: name.trim(), priceAdjustment: parsed.value });
      }}
    >
      <OptionFields
        idBase={idBase}
        name={name}
        price={price}
        onName={(value) => {
          setName(value);
          setError(null);
        }}
        onPrice={(value) => {
          setPrice(value);
          setError(null);
        }}
        error={error}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save option"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddOptionForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (input: { name: string; priceAdjustment: number }) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Card tone="subtle">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (name.trim() === "") {
            setError("Enter an option name.");
            return;
          }
          const parsed = parsePriceAdjustmentInput(price);
          if (!parsed.ok) {
            setError(parsed.error);
            return;
          }
          setError(null);
          if (await onAdd({ name: name.trim(), priceAdjustment: parsed.value })) {
            setName("");
            setPrice("");
          }
        }}
      >
        <h3 className="text-base font-semibold text-text-primary">Add an option</h3>
        <OptionFields
          idBase="new-option"
          name={name}
          price={price}
          onName={(value) => {
            setName(value);
            setError(null);
          }}
          onPrice={(value) => {
            setPrice(value);
            setError(null);
          }}
          error={error}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add option"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function OptionFields({
  idBase,
  name,
  price,
  onName,
  onPrice,
  error,
}: {
  idBase: string;
  name: string;
  price: string;
  onName: (value: string) => void;
  onPrice: (value: string) => void;
  error: string | null;
}) {
  return (
    <>
      <FormField label="Option name" htmlFor={`${idBase}-name`}>
        <input
          id={`${idBase}-name`}
          value={name}
          maxLength={120}
          onChange={(event) => onName(event.target.value)}
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11`}
        />
      </FormField>
      <FormField
        label="Extra charge"
        htmlFor={`${idBase}-price`}
        hint="In dollars, e.g. 0.50. Leave blank for no extra charge. Up to $100."
        error={error}
      >
        <input
          id={`${idBase}-price`}
          inputMode="decimal"
          value={price}
          onChange={(event) => onPrice(event.target.value)}
          placeholder="0.00"
          autoComplete="off"
          className={`${ADMIN_FIELD_CLASS} min-h-11 w-36`}
        />
      </FormField>
    </>
  );
}
