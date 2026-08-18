import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { EffectiveMenuProduct } from "@mocha-house/contracts";
import { getLocationMenu } from "@/lib/api";

interface CategoryGroup {
  id: string;
  name: string;
  displayOrder: number;
  products: EffectiveMenuProduct[];
}

// Groups already-available, already-ordered products by category, without
// re-sorting within a category — the API returns products pre-sorted by
// their menu displayOrder, and this grouping preserves that order.
function groupByCategory(products: EffectiveMenuProduct[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();

  for (const item of products) {
    if (!item.isAvailable) {
      continue;
    }

    const { category } = item.product;
    let group = groups.get(category.id);

    if (!group) {
      group = {
        id: category.id,
        name: category.name,
        displayOrder: category.displayOrder,
        products: [],
      };
      groups.set(category.id, group);
    }

    group.products.push(item);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.displayOrder !== b.displayOrder) {
      return a.displayOrder - b.displayOrder;
    }
    return a.name.localeCompare(b.name);
  });
}

function formatPrice(effectivePrice: number | null, currency: string): string {
  if (effectivePrice === null) {
    return "Price unavailable";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(effectivePrice / 100);
}

export default async function OrderMenuPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string | string[] }>;
}) {
  const { location: locationParam } = await searchParams;
  const locationId = Array.isArray(locationParam)
    ? locationParam[0]
    : locationParam;

  if (!locationId) {
    redirect("/order/location");
  }

  const locationMenu = await getLocationMenu(locationId);

  if (!locationMenu) {
    notFound();
  }

  const { location, menu } = locationMenu;

  if (!location.isDigitalOrderingEnabled) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            {location.name}
          </h1>
        </header>
        <div className="flex flex-col gap-3 rounded-xl border border-border-default bg-surface-subtle px-4 py-4">
          <p className="text-sm font-medium text-text-muted">
            Online ordering isn&apos;t available at this location right now.
          </p>
          <BackToLocationsLink />
        </div>
      </main>
    );
  }

  const categories = groupByCategory(menu.products);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          {location.name}
        </h1>
        <p className="text-sm text-text-secondary">{menu.name}</p>
      </header>

      {categories.length === 0 ? (
        <p className="text-sm text-text-muted">
          No items are available on this menu right now.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {categories.map((category) => (
            <section key={category.id} className="flex flex-col gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {category.name}
              </h2>
              <ul className="flex flex-col gap-3">
                {category.products.map((item) => (
                  <li key={item.product.id}>
                    <MenuProductRow item={item} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function MenuProductRow({ item }: { item: EffectiveMenuProduct }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 rounded-xl border border-border-default bg-surface-card px-4 py-4">
      <span className="text-base font-medium text-text-primary">
        {item.product.name}
      </span>
      <span className="shrink-0 text-base font-semibold text-text-primary">
        {formatPrice(item.effectivePrice, item.product.currency)}
      </span>
    </div>
  );
}

function BackToLocationsLink() {
  return (
    <Link
      href="/order/location"
      className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      Choose a different location
    </Link>
  );
}
