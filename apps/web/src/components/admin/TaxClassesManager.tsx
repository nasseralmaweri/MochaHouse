"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminTaxClass } from "@mocha-house/contracts";
import { createTaxClass, renameTaxClass } from "@/lib/admin/tax-client";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";
import { Card } from "@/components/Card";

// V1 Sales Tax PR 1 — the business's tax classes: add one, rename one.
export function TaxClassesManager({ classes }: { classes: AdminTaxClass[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    setPending(true);
    const result = await createTaxClass(name);
    setPending(false);
    if (result.outcome === "success") {
      setName("");
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  async function rename() {
    if (!editing) return;
    setError(null);
    setPending(true);
    const result = await renameTaxClass(editing.id, editing.name);
    setPending(false);
    if (result.outcome === "success") {
      setEditing(null);
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-border-default">
        {classes.map((taxClass) => (
          <li
            key={taxClass.id}
            className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
          >
            {editing?.id === taxClass.id ? (
              <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
                <label className="sr-only" htmlFor={`rename-${taxClass.id}`}>
                  New name for {taxClass.name}
                </label>
                <input
                  id={`rename-${taxClass.id}`}
                  value={editing.name}
                  maxLength={60}
                  onChange={(event) =>
                    setEditing({ id: taxClass.id, name: event.target.value })
                  }
                  className={`${ADMIN_FIELD_CLASS} w-full sm:max-w-xs`}
                />
                <div className="flex gap-2">
                  <Button onClick={() => void rename()} disabled={pending}>
                    Save
                  </Button>
                  <Button variant="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {taxClass.name}
                  </span>
                  {taxClass.isDefault ? <StatusBadge label="Default" /> : null}
                </div>
                <Button
                  variant="secondary"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setError(null);
                    setEditing({ id: taxClass.id, name: taxClass.name });
                  }}
                >
                  Rename
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 border-t border-border-default pt-4 sm:flex-row sm:items-end">
        <FormField
          label="Add a tax class"
          htmlFor="new-tax-class"
          hint="For example: Packaged Food, Grocery, Not taxed."
        >
          <input
            id="new-tax-class"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            className={`${ADMIN_FIELD_CLASS} w-full sm:w-72`}
          />
        </FormField>
        <Button
          onClick={() => void add()}
          disabled={pending || !name.trim()}
          className="w-full sm:w-auto"
        >
          Add class
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
