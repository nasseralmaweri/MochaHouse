"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminMenuSummary } from "@mocha-house/contracts";
import {
  assignLocationMenuFromBrowser,
  createMenuFromBrowser,
} from "@/lib/api-client";
import { Button, ButtonLink } from "./Button";
import { ADMIN_FIELD_CLASS, FormField } from "./form";

// SC4d — choose the menu a location sells from: create a new one (creating
// the same name twice returns the first, so a double click never makes two)
// or use one the business already has. The location then uses exactly that
// menu, and the owner continues to the menu to add products.
export function LocationMenuChooser({
  locationId,
  menus,
  currentMenuId,
}: {
  locationId: string;
  menus: AdminMenuSummary[];
  currentMenuId: string | null;
}) {
  const router = useRouter();
  const activeMenus = menus.filter((menu) => menu.isActive);
  const [name, setName] = useState(activeMenus.length === 0 ? "Main menu" : "");
  const [selected, setSelected] = useState(
    currentMenuId ?? activeMenus[0]?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function assign(menuId: string) {
    const result = await assignLocationMenuFromBrowser(locationId, menuId);
    if (result.outcome === "success") {
      router.push(`/admin/menu/menus/${encodeURIComponent(menuId)}`);
      router.refresh();
      return;
    }
    setPending(false);
    if (result.outcome === "forbidden") {
      setError("You don't have permission to change this location's menu.");
    } else if (result.outcome === "not-found") {
      setError("This location no longer exists.");
    } else {
      setError(result.message);
    }
  }

  async function createAndAssign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Enter a name for the menu.");
      return;
    }
    setPending(true);
    setError(null);
    const created = await createMenuFromBrowser(trimmed);
    if (created.outcome !== "success") {
      setPending(false);
      setError(
        created.outcome === "forbidden"
          ? "You don't have permission to create menus."
          : created.outcome === "not-found"
            ? "Couldn't create the menu. Please try again."
            : created.message,
      );
      return;
    }
    if (!created.data.menu.isActive) {
      setPending(false);
      setError(
        "A menu with this name exists but is turned off. Choose another name.",
      );
      return;
    }
    await assign(created.data.menu.id);
  }

  async function useExisting(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) {
      setError("Choose a menu.");
      return;
    }
    setPending(true);
    setError(null);
    await assign(selected);
  }

  return (
    <div className="flex max-w-lg flex-col gap-8">
      <form onSubmit={createAndAssign} className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-text-primary">
          Create a new menu
        </h2>
        <FormField
          label="Menu name"
          htmlFor="menu-name"
          hint="Customers see this name above your menu when they order online. If you already have a menu with this name, that menu is used."
        >
          <input
            id="menu-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            className={`${ADMIN_FIELD_CLASS} min-h-11`}
          />
        </FormField>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Create and use this menu"}
          </Button>
        </div>
      </form>

      {activeMenus.length > 0 ? (
        <form onSubmit={useExisting} className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-text-primary">
            Or use a menu you already have
          </h2>
          <FormField label="Menu" htmlFor="menu-existing">
            <select
              id="menu-existing"
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setError(null);
              }}
              className={`${ADMIN_FIELD_CLASS} min-h-11`}
            >
              {activeMenus.map((menu) => (
                <option key={menu.id} value={menu.id}>
                  {menu.name}
                  {menu.id === currentMenuId ? " (current)" : ""}
                </option>
              ))}
            </select>
          </FormField>
          <div>
            <Button type="submit" variant="secondary" disabled={pending}>
              Use this menu
            </Button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-status-warning">
          {error}
        </p>
      ) : null}

      <div>
        <ButtonLink href={`/admin/locations/${locationId}`} variant="secondary">
          Back to location
        </ButtonLink>
      </div>
    </div>
  );
}
