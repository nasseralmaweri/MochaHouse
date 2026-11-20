import type {
  AdminLocationTaxResponse,
  AdminTaxCategory,
  AdminTaxClass,
  AdminTaxProduct,
  ConfirmLocationTaxDraftRequest,
  TaxComponentInput,
} from "@mocha-house/contracts";
import { markedFetch } from "@/lib/security/marked-fetch";
import { taxRefusalMessage } from "./tax";

// V1 Sales Tax PR 1 — browser calls for Admin > Sales tax, through the
// Admin proxy (marked requests only). The API is the authority: tax.manage
// plus the business's built-in administrator role.

const BASE = "/api/internal/admin/tax";

export type TaxWriteResult<T> =
  | { outcome: "success"; data: T }
  | { outcome: "refused"; status: number | null; code: string | null; message: string };

async function send<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<TaxWriteResult<T>> {
  let response: Response;
  try {
    response = await markedFetch(`${BASE}/${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { outcome: "refused", status: null, code: null, message: taxRefusalMessage(null, null) };
  }
  if (!response.ok) {
    let payload: { code?: unknown; message?: unknown } | null = null;
    try {
      payload = (await response.json()) as { code?: unknown; message?: unknown };
    } catch {
      payload = null;
    }
    return {
      outcome: "refused",
      status: response.status,
      code: typeof payload?.code === "string" ? payload.code : null,
      message: taxRefusalMessage(response.status, payload),
    };
  }
  const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { outcome: "success", data };
}

const id = (value: string) => encodeURIComponent(value);

export const createTaxClass = (name: string) =>
  send<AdminTaxClass>("classes", "POST", { name });

export const renameTaxClass = (taxClassId: string, name: string) =>
  send<AdminTaxClass>(`classes/${id(taxClassId)}`, "PATCH", { name });

export const setCategoryTaxClass = (categoryId: string, taxClassId: string) =>
  send<AdminTaxCategory>(`categories/${id(categoryId)}`, "PUT", { taxClassId });

export const setProductTaxClass = (productId: string, taxClassId: string | null) =>
  send<AdminTaxProduct>(`products/${id(productId)}`, "PUT", { taxClassId });

export const saveLocationTaxDraft = (locationId: string, components: TaxComponentInput[]) =>
  send<AdminLocationTaxResponse>(`locations/${id(locationId)}/draft`, "PUT", { components });

export const discardLocationTaxDraft = (locationId: string) =>
  send<AdminLocationTaxResponse>(`locations/${id(locationId)}/draft`, "DELETE");

export const confirmLocationTaxDraft = (
  locationId: string,
  body: ConfirmLocationTaxDraftRequest,
) => send<AdminLocationTaxResponse>(`locations/${id(locationId)}/draft/confirm`, "POST", body);
