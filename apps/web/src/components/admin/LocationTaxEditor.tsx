"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  TAX_COMPONENTS_MAX,
  TAX_JURISDICTIONS,
  parseTaxRatePercent,
  type AdminLocationTaxResponse,
  type TaxJurisdiction,
} from "@mocha-house/contracts";
import {
  confirmLocationTaxDraft,
  discardLocationTaxDraft,
  saveLocationTaxDraft,
} from "@/lib/admin/tax-client";
import {
  JURISDICTION_LABELS,
  classTotalRatePpm,
  ratePercentLabel,
  rowsFromComponents,
  validateDraftRows,
  type TaxComponentDraftRow,
} from "@/lib/admin/tax";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { Card } from "@/components/Card";

let nextKey = 0;
const newRow = (defaultClassId: string | undefined): TaxComponentDraftRow => ({
  key: `new-${(nextKey += 1)}`,
  name: "",
  jurisdiction: "STATE",
  ratePercent: "",
  taxClassIds: defaultClassId ? [defaultClassId] : [],
});

// V1 Sales Tax PR 1 — edit a location's draft taxes, then confirm them.
// Confirmed settings are never edited: saving makes (or updates) a draft,
// and confirming the draft replaces the confirmed version, which is kept in
// the history.
export function LocationTaxEditor({ data }: { data: AdminLocationTaxResponse }) {
  const router = useRouter();
  const defaultClassId = data.classes.find((c) => c.isDefault)?.id;
  const source = data.draft ?? data.confirmed;
  const [rows, setRows] = useState<TaxComponentDraftRow[]>(() =>
    source ? rowsFromComponents(source.components) : [newRow(defaultClassId)],
  );
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const update = (key: string, patch: Partial<TaxComponentDraftRow>) => {
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setDirty(true);
    setNotice(null);
  };

  async function save() {
    setMessage(null);
    setNotice(null);
    const checked = validateDraftRows(rows);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setPending(true);
    const result = await saveLocationTaxDraft(data.location.id, checked.components);
    setPending(false);
    if (result.outcome === "success") {
      setDirty(false);
      setAcknowledged(false);
      setNotice("Draft saved. Review it below, then confirm it.");
      router.refresh();
    } else {
      setMessage(result.message);
    }
  }

  async function discard() {
    setMessage(null);
    setPending(true);
    const result = await discardLocationTaxDraft(data.location.id);
    setPending(false);
    if (result.outcome === "success") {
      const back = result.data.confirmed;
      setRows(back ? rowsFromComponents(back.components) : [newRow(defaultClassId)]);
      setDirty(false);
      setNotice("Draft discarded.");
      router.refresh();
    } else {
      setMessage(result.message);
    }
  }

  async function confirm() {
    if (!data.draft) return;
    setMessage(null);
    setPending(true);
    const result = await confirmLocationTaxDraft(data.location.id, {
      draftId: data.draft.id,
      draftUpdatedAt: data.draft.updatedAt,
    });
    setPending(false);
    if (result.outcome === "success") {
      setAcknowledged(false);
      setNotice(`Version ${result.data.confirmed?.version ?? ""} confirmed.`);
      router.refresh();
    } else {
      setMessage(result.message);
    }
  }

  const draft = data.draft;
  const canConfirm =
    draft !== null && !dirty && data.unreviewedActiveCategories === 0;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-text-primary">
            {draft ? `Draft — version ${draft.version}` : "Edit taxes"}
          </h3>
          <p className="text-sm text-text-secondary">
            Add each tax that applies at this location (state, county, city or
            special district) and the tax classes it applies to. A class no
            tax applies to is not taxed here.
          </p>
        </div>

        {errors.form ? (
          <p role="alert" className="text-sm text-status-warning">
            {errors.form}
          </p>
        ) : null}

        <ol className="flex flex-col gap-4">
          {rows.map((row, index) => {
            const parsed = parseTaxRatePercent(row.ratePercent);
            return (
              <li
                key={row.key}
                className="flex flex-col gap-3 rounded-xl border border-border-default p-3"
              >
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_7rem]">
                  <FormField label={`Tax ${index + 1} name`} htmlFor={`${row.key}-name`}>
                    <input
                      id={`${row.key}-name`}
                      value={row.name}
                      maxLength={80}
                      placeholder="Michigan sales tax"
                      onChange={(event) => update(row.key, { name: event.target.value })}
                      className={`${ADMIN_FIELD_CLASS} w-full`}
                    />
                  </FormField>
                  <FormField label="Type" htmlFor={`${row.key}-type`}>
                    <select
                      id={`${row.key}-type`}
                      value={row.jurisdiction}
                      onChange={(event) =>
                        update(row.key, {
                          jurisdiction: event.target.value as TaxJurisdiction,
                        })
                      }
                      className={`${ADMIN_FIELD_CLASS} w-full`}
                    >
                      {TAX_JURISDICTIONS.map((j) => (
                        <option key={j} value={j}>
                          {JURISDICTION_LABELS[j]}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Rate (%)" htmlFor={`${row.key}-rate`}>
                    <input
                      id={`${row.key}-rate`}
                      inputMode="decimal"
                      value={row.ratePercent}
                      placeholder="6.25"
                      onChange={(event) =>
                        update(row.key, { ratePercent: event.target.value })
                      }
                      className={`${ADMIN_FIELD_CLASS} w-full`}
                    />
                  </FormField>
                </div>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium text-text-primary">
                    Applies to
                  </legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {data.classes.map((taxClass) => (
                      <label
                        key={taxClass.id}
                        className="flex min-h-11 items-center gap-2 text-sm text-text-primary"
                      >
                        <input
                          type="checkbox"
                          checked={row.taxClassIds.includes(taxClass.id)}
                          onChange={(event) =>
                            update(row.key, {
                              taxClassIds: event.target.checked
                                ? [...row.taxClassIds, taxClass.id]
                                : row.taxClassIds.filter((id) => id !== taxClass.id),
                            })
                          }
                        />
                        {taxClass.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {errors[row.key] ? (
                  <p role="alert" className="text-sm text-status-warning">
                    {errors[row.key]}
                  </p>
                ) : parsed.ok ? (
                  <p className="text-xs text-text-secondary">
                    Stored exactly as {ratePercentLabel(parsed.ratePpm)} (up
                    to 4 decimal places).
                  </p>
                ) : null}
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRows(rows.filter((r) => r.key !== row.key));
                      setDirty(true);
                    }}
                  >
                    Remove tax
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>

        {rows.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No taxes: nothing would be charged at this location.
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="secondary"
            disabled={rows.length >= TAX_COMPONENTS_MAX}
            onClick={() => {
              setRows([...rows, newRow(defaultClassId)]);
              setDirty(true);
            }}
          >
            Add a tax
          </Button>
          <Button onClick={() => void save()} disabled={pending}>
            {pending ? "Saving…" : "Save draft"}
          </Button>
          {draft ? (
            <Button variant="secondary" onClick={() => void discard()} disabled={pending}>
              Discard draft
            </Button>
          ) : null}
        </div>
        {notice ? (
          <p role="status" className="text-sm text-status-success">
            {notice}
          </p>
        ) : null}
        {message ? (
          <p role="alert" className="text-sm text-status-warning">
            {message}
          </p>
        ) : null}
      </Card>

      {draft ? (
        <Card className="flex flex-col gap-3">
          <h3 className="text-base font-semibold text-text-primary">
            Confirm version {draft.version}
          </h3>
          <ul className="flex flex-col gap-1 text-sm text-text-primary">
            {data.classes.map((taxClass) => (
              <li key={taxClass.id}>
                {taxClass.name}:{" "}
                <span className="font-medium">
                  {ratePercentLabel(classTotalRatePpm(draft.components, taxClass.id))}
                </span>{" "}
                total
              </li>
            ))}
          </ul>
          {data.unreviewedActiveCategories > 0 ? (
            <p className="text-sm text-status-warning">
              Review the tax class of every active category first (
              {data.unreviewedActiveCategories} still to review on the Sales
              tax page).
            </p>
          ) : null}
          {dirty ? (
            <p className="text-sm text-status-warning">
              Save your changes before confirming.
            </p>
          ) : null}
          <label className="flex items-start gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I&apos;ve checked these rates against this location&apos;s
            official state and local tax rates.
          </label>
          <div>
            <Button
              onClick={() => void confirm()}
              disabled={pending || !canConfirm || !acknowledged}
            >
              Confirm tax settings
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
